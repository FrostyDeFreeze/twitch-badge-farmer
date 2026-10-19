import type { Campaign, Config, DropProgress, DropReference, GlobalBadge, SelectedStream, Stream, Task } from './types.ts'

interface GqlData {
	GlobalBadges: { badges?: GlobalBadge[] }
	ViewerCard: { channelViewer?: { earnedBadges?: { setID: string; version: string | number }[] } | null }
	Inventory: { currentUser?: { inventory?: { dropCampaignsInProgress?: Campaign[] | null } } | null }
	DropsHighlightService_AvailableDrops: { channel?: { viewerDropCampaigns?: Campaign[] | null } | null }
	PlaybackAccessToken: { streamPlaybackAccessToken?: { signature?: string; value?: string } | null }
	DropsPage_ClaimDropRewards: { claimDropRewards?: { status?: string } | null }
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
import { matchesDrop } from './catalog.ts'

const USER_AGENT =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.1 Mobile/15E148 Safari/604.1'
const QUERIES: Partial<Record<keyof GqlData, string>> = {
	PlaybackAccessToken: 'ed230aa1e33e07eebb8928504583da78a5173989fadfb1ac94be06a04f3cdbe9',
	Inventory: '3ab317a5753b25125f47d4ce962ebe928ff4e85047b77508340c94ebc20b6230',
	DropsHighlightService_AvailableDrops: '782dad0f032942260171d2d80a654f88bdd0c5a9dddc392e9bc92218a0f42d20',
	DropsPage_ClaimDropRewards: 'a455deea71bdc9015b78eb49f4acfbce8baa7ccbedd28e549bb025bd0f751930'
}

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
		throw new Error('Twitch: unexpected URL in server response')
	}

	return url.href
}

function playlistLines(text: string) {
	const lines = text
		.trim()
		.split(/\r?\n/)
		.map(line => line.trim())
		.filter(Boolean)

	if (lines[0] !== '#EXTM3U') throw new Error('Twitch: invalid HLS playlist')

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

	if (!variants.length) throw new Error('Twitch: no video variant available')

	return variants[0]!.url
}

export function playlistSegments(text: string, base: string | URL) {
	const lines = playlistLines(text)

	if (lines.includes('#EXT-X-ENDLIST')) throw new Error('Twitch: stream ended')

	const segments = []

	for (let index = 0; index < lines.length; index++) {
		if (lines[index]!.startsWith('#EXTINF:') && lines[index + 1] && !lines[index + 1]!.startsWith('#')) {
			segments.push(cdnUrl(lines[index + 1]!, base))
		}
	}

	if (!segments.length) throw new Error('Twitch: no current HLS segments')

	return [...new Set(segments)]
}

export class Twitch {
	config: Config
	signal: AbortSignal | undefined
	playback: { id: string; url: string } | null

	constructor(config: Config, signal?: AbortSignal) {
		this.config = config
		this.signal = signal
		this.playback = null
	}

	headers(prefix = 'Bearer') {
		return { Authorization: prefix + ' ' + this.config.token, 'Client-Id': this.config.client_id, 'User-Agent': USER_AGENT }
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
			const reason = /PersistedQueryNotFound/i.test(messages)
				? 'persisted query unavailable, update the utility'
				: /integrity/i.test(messages)
					? 'integrity check rejected'
					: authRejected
						? 'authorization rejected'
						: /Cannot query field|Unknown argument/i.test(messages)
							? 'query schema changed'
							: 'request rejected'
			const code = result.errors.find(error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error.extensions?.code || ''))?.extensions?.code
			const error = new Error('GQL ' + operationName + ': ' + reason + (code ? ' (' + code + ')' : ''))

			error.fatal = authRejected || /integrity|PersistedQueryNotFound/i.test(messages)
			if (authRejected) error.message += ', run with --gen-token'

			throw error
		}

		if (!result.data) throw new Error('GQL ' + operationName + ': missing response data')

		return result.data
	}

	async globalBadges() {
		const data = await this.gql('GlobalBadges', {}, 'query GlobalBadges { badges { setID version title imageURL(size: QUADRUPLE) user { id } } }')

		if (!Array.isArray(data.badges)) throw new Error('GlobalBadges: missing badge list')

		const badges = data.badges.filter(badge => badge.user === null)

		if (badges.some(badge => !badge.setID || badge.version == null || !badge.title)) throw new Error('GlobalBadges: invalid badge metadata')

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

		if (!Array.isArray(badges)) throw new Error('ViewerCard: missing earned badge list')

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

				if (!Array.isArray(data.data)) throw new Error('Helix: unsupported stream list format')

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

			const data = await this.gql('DropsHighlightService_AvailableDrops', { channelID: stream.user_id })
			const campaigns = data.channel?.viewerDropCampaigns

			if (data.channel === null || campaigns === null) continue
			if (!Array.isArray(campaigns)) throw new Error('Twitch Drops: campaign list unavailable for ' + stream.user_login)

			for (const campaign of campaigns) {
				if (campaign.game && campaign.game.id !== stream.game_id) continue
				if (expectedDrop && campaign.id !== expectedDrop.campaignId) continue

				const drop = campaign.timeBasedDrops?.find(
					drop => (!expectedDrop || drop.id === expectedDrop.id) && matchesDrop(task, campaign, drop)
				)

				if (drop) {
					return { ...stream, drop: { id: drop.id, campaignId: campaign.id, requiredMinutesWatched: drop.requiredMinutesWatched } }
				}
			}
		}

		return null
	}

	async inventory() {
		const data = await this.gql('Inventory', { fetchRewardCampaigns: true })

		if (data.currentUser === null) {
			const error = new Error('Inventory: authorization rejected, run with --gen-token')
			error.fatal = true
			throw error
		}

		const campaigns = data.currentUser?.inventory?.dropCampaignsInProgress

		if (campaigns === null) return []
		if (!Array.isArray(campaigns)) throw new Error('Inventory: missing Drops campaigns')

		return campaigns
	}

	async dropProgress(drop: DropReference, campaigns?: Campaign[]): Promise<DropProgress | null> {
		campaigns ??= await this.inventory()

		const campaign = campaigns.find(campaign => campaign.id === drop.campaignId)
		const item = campaign?.timeBasedDrops?.find(item => item.id === drop.id)

		if (!item?.self) return null

		if (!Number.isFinite(item.self.currentMinutesWatched) || !(item.requiredMinutesWatched > 0)) {
			throw new Error('Inventory: invalid Drops progress')
		}

		return { ...item.self, requiredMinutesWatched: item.requiredMinutesWatched }
	}

	async claimDrop(dropInstanceID: string) {
		const data = await this.gql('DropsPage_ClaimDropRewards', { input: { dropInstanceID } })

		if (!['ELIGIBLE_FOR_ALL', 'DROP_INSTANCE_ALREADY_CLAIMED'].includes(data.claimDropRewards?.status || '')) {
			throw new Error('Twitch: Drop claim not accepted')
		}
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

				if (!access?.signature || !access?.value) throw new Error('GQL: playback access token missing')

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

				if (![200, 206].includes(response.status)) throw new Error('Twitch: segment unavailable')
			}
		} catch (error) {
			if (!(error instanceof Error)) throw error

			this.playback = null

			throw error
		}
	}
}
