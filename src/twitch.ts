import type { Campaign, Config, DropProgress, DropReference, GlobalBadge, RewardGroup, SelectedStream, Stream, Task } from './types.ts'

interface GqlData {
	ViewerRewardDropInventory: { currentUser?: { id?: string; inventory?: { viewerRewardDropCampaignsInProgress?: Campaign[] | null } } | null }
	DropChannelCampaignsProgress: { channelDropCampaignsProgress?: Campaign[] | null }
	ProgressionTrackSelections: { trackSelections?: { track: string; lane: string | null }[] | null }
	SetProgressionTrackSelection: { setTrackSelection?: { error?: string | null } | null }
	GlobalBadges: { badges?: GlobalBadge[] }
	ViewerCard: { channelViewer?: { earnedBadges?: { setID: string; version: string | number }[] } | null }
	Inventory: { currentUser?: { inventory?: { dropCampaignsInProgress?: Campaign[] | null } } | null }
	DropsHighlightService_AvailableDrops: { channel?: { viewerDropCampaigns?: Campaign[] | null } | null }
	PlaybackAccessToken: { streamPlaybackAccessToken?: { signature?: string; value?: string } | null }
}

interface GqlResponse<T> {
	data?: T
	errors?: { message?: string; extensions?: { code?: string } }[]
}

interface GqlBody {
	operationName: keyof GqlData
	variables: Record<string, unknown>
	query?: string
	extensions?: { persistedQuery: { version: number; sha256Hash: string | undefined } }
}

interface StreamOptions {
	exclude?: Set<string>
	drop?: DropReference | null | undefined
}

import { fetchResponse, fetchJson, fetchText } from './fetch.ts'
import { dropCandidates, matchesDrop, SPECIAL_EVENTS } from './catalog.ts'
import { dailyProgress, matchesReward } from './rewards.ts'
import { createLogger, type Logger } from './logger.ts'

const USER_AGENT =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.1 Mobile/15E148 Safari/604.1'
const QUERIES: Partial<Record<keyof GqlData, string>> = {
	PlaybackAccessToken: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9',
	Inventory: '3ab317a5753b25125f47d4ce962ebe928ff4e85047b77508340c94ebc20b6230',
	DropsHighlightService_AvailableDrops: '782dad0f032942260171d2d80a654f88bdd0c5a9dddc392e9bc92218a0f42d20'
}

// channel reward groups are shared by every badge searched in one selection pass
const CHANNEL_REWARDS_TTL = 300_000

const REWARD_FIELDS = `id track lane
 progressCriteria { requirementType requirements { minutesWatched subs turboSubs }
  repeatableConfig { repeatableTimes resetIntervalSeconds shouldCompleteAllRepeatsToEarn } }
 self { status currentMinutesWatched grantCount nextEligibleAt currentWindow { startedAt expiresAt } hasPreconditionsMet earnedReward { id } }
 rewards { distributionType dropDetail { badge { setID version } } pool { rewards { distributionType dropDetail { badge { setID version } } } } }`

function cdnUrl(value: string, base: string | URL) {
	const url = new URL(value, base)
	const domains = ['ttvnw.net', 'twitchcdn.net', 'cloudfront.net']

	if (
		url.protocol !== 'https:' ||
		url.username ||
		url.password ||
		(url.port && url.port !== '443') ||
		!domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))
	) {
		throw new Error('Twitch | Unexpected URL in response')
	}

	return url.href
}

function playlistLines(text: string) {
	const lines = text
		.trim()
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)

	if (lines[0] !== '#EXTM3U') throw new Error('HLS | Invalid playlist')

	return lines
}

export function chooseVariant(text: string, base: string | URL) {
	const lines = playlistLines(text)
	const variants = []

	for (let index = 0; index < lines.length; index++) {
		if (!lines[index]!.startsWith('#EXT-X-STREAM-INF:')) continue

		const info = Object.fromEntries(
			[...lines[index]!.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(match => [match[1]!, match[2]!.replace(/^"|"$/g, '')])
		)
		const video = info.RESOLUTION || /avc|hvc|hev|av01|vp0?9/i.test(info.CODECS || '')
		const bandwidth = Number(info['AVERAGE-BANDWIDTH'] || info.BANDWIDTH)
		const nextLine = lines[index + 1]

		if (video && bandwidth > 0 && Number.isFinite(bandwidth) && nextLine && !nextLine.startsWith('#')) {
			variants.push({ bandwidth, url: cdnUrl(nextLine, base) })
		}
	}

	variants.sort((left, right) => left.bandwidth - right.bandwidth)

	if (!variants.length) throw new Error('HLS | No video variant')

	return variants[0]!.url
}

export function playlistSegments(text: string, base: string | URL) {
	const lines = playlistLines(text)

	if (lines.includes('#EXT-X-ENDLIST')) throw new Error('HLS | Stream ended')

	const segments = []

	for (let index = 0; index < lines.length; index++) {
		if (lines[index]!.startsWith('#EXTINF:') && lines[index + 1] && !lines[index + 1]!.startsWith('#')) {
			segments.push(cdnUrl(lines[index + 1]!, base))
		}
	}

	if (!segments.length) throw new Error('HLS | No current segments')

	return [...new Set(segments)]
}

export class Twitch {
	config: Config
	signal: AbortSignal | undefined
	playback: { id: string; url: string } | null
	selectedTracks = new Map<string, string>()
	channelRewards = new Map<string, { expiresAt: number; campaigns: Campaign[] | null }>()
	log: Logger

	constructor(config: Config, signal?: AbortSignal, log = createLogger({ token: config.token })) {
		this.config = config
		this.signal = signal
		this.log = log
		this.playback = null
	}

	headers() {
		return { Authorization: 'Bearer ' + this.config.token, 'Client-Id': this.config.client_id, 'User-Agent': USER_AGENT }
	}

	async gql<K extends keyof GqlData>(operationName: K, variables: Record<string, unknown>, query?: string): Promise<GqlData[K]> {
		const body: GqlBody = { operationName, variables }
		const headers: Record<string, string> = { 'Client-Id': this.config.client_id, 'User-Agent': USER_AGENT, 'Content-Type': 'application/json' }

		if (!['GlobalBadges', 'ViewerCard', 'DropsHighlightService_AvailableDrops'].includes(operationName)) {
			headers.Authorization = 'OAuth ' + this.config.token
		}

		if (query) body.query = query
		else body.extensions = { persistedQuery: { version: 1, sha256Hash: QUERIES[operationName] } }

		const result = await fetchJson<GqlResponse<GqlData[K]>>('https://gql.twitch.tv/gql', {
			method: 'POST',
			fatalAuth: true,
			signal: this.signal,
			label: 'GQL ' + operationName,
			headers,
			body: JSON.stringify(body)
		})

		if (result.errors?.length) {
			const messages = result.errors.map(error => error.message || '').join(' ')
			const authRejected = result.errors.some(error =>
				/unauthoriz|unauthenticated|forbidden|access.?denied|invalid.*token|token.*(?:invalid|expired)|login.*required/i.test(
					(error.message || '') + ' ' + (error.extensions?.code || '')
				)
			)
			const outdated = /PersistedQueryNotFound/i.test(messages)
			const reason = outdated
				? 'Persisted query unavailable'
				: /integrity/i.test(messages)
					? 'Integrity check rejected'
					: authRejected
						? 'Authorization rejected'
						: /Cannot query field|Unknown argument/i.test(messages)
							? 'Query schema changed'
							: 'Request rejected'
			const code = result.errors.find(error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error.extensions?.code || ''))?.extensions?.code
			const action = outdated ? 'Update the program' : authRejected ? 'Run with --gen-token' : ''
			const error = new Error(['GQL ' + operationName, reason + (code ? ' (' + code + ')' : ''), action].filter(Boolean).join(' | '))

			error.fatal = authRejected || /integrity|PersistedQueryNotFound/i.test(messages)

			throw error
		}

		if (!result.data) throw new Error('GQL ' + operationName + ' | Missing response data')

		return result.data
	}

	async globalBadges() {
		const data = await this.gql('GlobalBadges', {}, 'query GlobalBadges { badges { setID version title user { id } } }')

		if (!Array.isArray(data.badges)) throw new Error('GQL GlobalBadges | Missing badge list')

		const badges = data.badges.filter(badge => badge.user === null)

		if (badges.some(badge => !badge.setID || badge.version == null || !badge.title)) throw new Error('GQL GlobalBadges | Invalid badge metadata')

		return new Map(badges.map(badge => [badge.setID + ':' + badge.version, badge]))
	}

	async badges() {
		const data = await this.gql(
			'ViewerCard',
			{
				channelLogin: this.config.login,
				userLogin: this.config.login
			},
			`query ViewerCard($channelLogin: String!, $userLogin: String!) {
			channelViewer(channelLogin: $channelLogin, userLogin: $userLogin) {
				earnedBadges { setID version }
			}
		}`
		)

		const badges = data.channelViewer?.earnedBadges

		if (!Array.isArray(badges)) throw new Error('GQL ViewerCard | Missing earned badge list')

		return new Set(badges.map(badge => badge.setID + ':' + badge.version))
	}

	async streams(task: Task) {
		const batches = (values: string[]) =>
			values.length ? Array.from({ length: Math.ceil(values.length / 100) }, (_, index) => values.slice(index * 100, index * 100 + 100)) : [[]]
		const result = new Map<string, Stream>()

		for (const channels of batches(task.channels.map(channel => channel.id))) {
			for (const categories of batches(task.categoryIds)) {
				const url = new URL('https://api.twitch.tv/helix/streams')

				url.searchParams.set('first', '100')
				url.searchParams.set('type', 'live')

				for (const id of channels) url.searchParams.append('user_id', id)
				for (const id of categories) url.searchParams.append('game_id', id)

				const data = await fetchJson<{ data?: Stream[] }>(url, {
					headers: this.headers(),
					fatalAuth: true,
					signal: this.signal,
					label: 'Helix streams'
				})

				if (!Array.isArray(data.data)) throw new Error('Helix streams | Unsupported response format')

				for (const stream of data.data) {
					if (stream.type !== 'live' || !stream.id || !stream.user_id || !stream.user_login) continue
					if (task.categoryIds.length && !task.categoryIds.includes(stream.game_id)) continue
					if (task.channels.length && !task.channels.some(channel => channel.id === stream.user_id)) continue

					result.set(stream.user_id, stream)
				}
			}
		}

		return [...result.values()].sort((left, right) => (right.viewer_count || 0) - (left.viewer_count || 0))
	}

	async selectStream(task: Task, { exclude = new Set(), drop: expectedDrop }: StreamOptions = {}): Promise<SelectedStream | null> {
		const streams = await this.streams(task)

		for (const stream of streams) {
			if (exclude.has(stream.user_id)) continue

			if (task.days) {
				const campaigns = await this.channelCampaigns(stream.user_id)

				if (campaigns === null) continue

				const matches = campaigns.flatMap(campaign =>
					(campaign.rewardGroups ?? [])
						.filter(
							group =>
								(!expectedDrop ||
									(expectedDrop.kind === 'reward-group' &&
										expectedDrop.campaignId === campaign.id &&
										expectedDrop.id === group.id)) &&
								matchesReward(task, campaign, group)
						)
						.map(group => ({ campaign, group }))
				)

				if (matches.length !== 1) continue

				const { campaign, group } = matches[0]!

				await this.selectTrack(group)

				return { ...stream, drop: { id: group.id, campaignId: campaign.id, kind: 'reward-group' } }
			}

			const data = await this.gql('DropsHighlightService_AvailableDrops', { channelID: stream.user_id })
			const campaigns = data.channel?.viewerDropCampaigns

			if (data.channel === null || campaigns === null) continue
			if (!Array.isArray(campaigns)) throw new Error('Twitch Drops | Campaign list unavailable | ' + stream.user_login)

			const matches = campaigns.flatMap(campaign =>
				(campaign.game && campaign.game.id !== stream.game_id && !SPECIAL_EVENTS.includes(campaign.game.id)) ||
				(expectedDrop && campaign.id !== expectedDrop.campaignId)
					? []
					: (campaign.timeBasedDrops ?? [])
							.filter(drop => (!expectedDrop || drop.id === expectedDrop.id) && matchesDrop(task, campaign, drop))
							.map(drop => ({ campaign, drop }))
			)
			const [match] = dropCandidates(task, matches)

			if (match) return { ...stream, drop: { id: match.drop.id, campaignId: match.campaign.id } }
		}

		return null
	}

	async channelCampaigns(channelID: string) {
		const now = Date.now()
		const cached = this.channelRewards.get(channelID)

		if (cached && cached.expiresAt > now) return cached.campaigns

		const data = await this.gql(
			'DropChannelCampaignsProgress',
			{ channelID },
			`query DropChannelCampaignsProgress($channelID: ID!) {
      channelDropCampaignsProgress(channelID: $channelID) { id startAt endAt rewardGroups { ${REWARD_FIELDS} } }
     }`
		)

		const campaigns = data.channelDropCampaignsProgress

		if (campaigns !== null && !Array.isArray(campaigns)) throw new Error('Twitch | Daily channel rewards unavailable')

		for (const [id, entry] of this.channelRewards) if (entry.expiresAt <= now) this.channelRewards.delete(id)

		this.channelRewards.set(channelID, { expiresAt: now + CHANNEL_REWARDS_TTL, campaigns: campaigns ?? null })

		return campaigns ?? null
	}

	async selectTrack(group: RewardGroup) {
		if (!group.track && !group.lane) return
		if (!group.track || !group.lane) throw new Error('Twitch | Incomplete progression track')

		const { track, lane } = group

		const read = async () => {
			const data = await this.gql(
				'ProgressionTrackSelections',
				{ tracks: [track] },
				'query ProgressionTrackSelections($tracks: [ID!]!) { trackSelections(tracks: $tracks) { track lane } }'
			)

			if (!Array.isArray(data.trackSelections)) throw new Error('Twitch | Missing progression selection')

			return data.trackSelections.find(selection => selection.track === track)?.lane
		}

		const selected = await read()

		if (selected !== lane) {
			if (this.selectedTracks.has(track) && selected !== this.selectedTracks.get(track))
				throw new Error('Twitch | Progression selection changed outside the program')

			const data = await this.gql(
				'SetProgressionTrackSelection',
				{ input: { track, lane } },
				'mutation SetProgressionTrackSelection($input: SetTrackSelectionInput!) { setTrackSelection(input: $input) { error } }'
			)

			if (!data.setTrackSelection || data.setTrackSelection.error !== null) throw new Error('Twitch | Progression selection rejected')
			if ((await read()) !== lane) throw new Error('Twitch | Progression selection not confirmed')
		}

		this.selectedTracks.set(track, lane)
	}

	async rewardCampaigns() {
		const data = await this.gql(
			'ViewerRewardDropInventory',
			{},
			`query ViewerRewardDropInventory {
    currentUser { id inventory { viewerRewardDropCampaignsInProgress { id startAt endAt rewardGroups { ${REWARD_FIELDS} } } } }
   }`
		)

		if (data.currentUser?.id !== this.config.id) throw new Error('Inventory | Missing or mismatched account identity')

		const campaigns = data.currentUser.inventory?.viewerRewardDropCampaignsInProgress

		if (campaigns !== null && !Array.isArray(campaigns)) throw new Error('Inventory | Missing daily reward campaigns')

		if (
			campaigns?.some(
				campaign =>
					!campaign ||
					typeof campaign.id !== 'string' ||
					!campaign.id ||
					!Array.isArray(campaign.rewardGroups) ||
					campaign.rewardGroups.some(group => !group || typeof group.id !== 'string' || !group.id || !Array.isArray(group.rewards))
			)
		) {
			throw new Error('Inventory | Invalid daily reward campaigns')
		}

		return campaigns ?? []
	}

	async inventory() {
		const [data, daily] = await Promise.all([
			this.gql('Inventory', { fetchRewardCampaigns: true }),
			this.rewardCampaigns().catch(error => {
				if (!(error instanceof Error) || error.fatal || this.signal?.aborted) throw error

				// the daily query is unpersisted and private, so a schema change must not stop ordinary Drops
				this.log.debug('[TWITCH] Daily rewards unavailable | ' + error.message)

				return []
			})
		])

		if (data.currentUser === null) {
			const error = new Error('Inventory | Authorization rejected | Run with --gen-token')

			error.fatal = true

			throw error
		}

		const campaigns = data.currentUser?.inventory?.dropCampaignsInProgress

		if (campaigns !== null && !Array.isArray(campaigns)) throw new Error('Inventory | Missing Drops campaigns')

		return [...(campaigns ?? []), ...daily]
	}

	async dropProgress(drop: DropReference, key: string, campaigns?: Campaign[], now = Date.now()): Promise<DropProgress | null> {
		campaigns ??= await this.inventory()

		if (drop.kind === 'reward-group') {
			const group = campaigns
				.find(campaign => campaign.id === drop.campaignId && campaign.rewardGroups)
				?.rewardGroups?.find(group => group.id === drop.id)

			return group ? dailyProgress(group, key, now) : null
		}

		const campaign = campaigns.find(campaign => campaign.id === drop.campaignId && campaign.timeBasedDrops)
		const item = campaign?.timeBasedDrops?.find(item => item.id === drop.id)

		if (!item?.self) return null

		if (!Number.isFinite(item.self.currentMinutesWatched) || !(item.requiredMinutesWatched > 0)) {
			throw new Error('Inventory | Invalid Drops progress')
		}

		return { ...item.self, requiredMinutesWatched: item.requiredMinutesWatched }
	}

	async watch(stream: SelectedStream) {
		const headers = { 'User-Agent': USER_AGENT }

		try {
			if (this.playback?.id !== stream.id) {
				const data = await this.gql('PlaybackAccessToken', {
					isLive: true,
					login: stream.user_login,
					isVod: false,
					vodID: '',
					playerType: 'site',
					platform: 'web'
				})
				const access = data.streamPlaybackAccessToken

				if (!access?.signature || !access?.value) throw new Error('GQL PlaybackAccessToken | Token missing')

				const masterUrl = new URL('https://usher.ttvnw.net/api/channel/hls/' + stream.user_login + '.m3u8')

				for (const [key, value] of Object.entries({
					sig: access.signature,
					token: access.value,
					allow_source: 'true',
					allow_audio_only: 'false',
					platform: 'web',
					supported_codecs: 'h264'
				})) {
					masterUrl.searchParams.set(key, value)
				}

				const master = await fetchText(masterUrl, { headers, signal: this.signal, label: 'HLS master' })

				this.playback = { id: stream.id, url: chooseVariant(master, masterUrl) }
			}

			const media = await fetchText(this.playback.url, { headers, signal: this.signal, label: 'HLS media playlist' })
			const segments = playlistSegments(media, this.playback.url)

			// reuse the playback session and touch the full segment window
			for (const [index, segment] of segments.entries()) {
				const response = await fetchResponse(segment, {
					method: 'HEAD',
					headers,
					signal: this.signal,
					label: 'HLS segment ' + (index + 1) + '/' + segments.length
				})

				if (![200, 206].includes(response.status)) throw new Error('HLS | Segment unavailable')
			}
		} catch (error) {
			if (!(error instanceof Error)) throw error

			this.playback = null

			throw error
		}
	}
}
