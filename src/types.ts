export interface Config {
	id: string
	login: string
	client_id: string
	token: string
}

export interface Channel {
	id: string
	login: string
}

export interface DropReference {
	id: string
	campaignId: string
	requiredMinutesWatched?: number
}

export interface Task {
	key: string
	title: string
	rewardTitle: string
	image?: string | undefined
	availabilityId?: string | number | undefined
	minutes: number
	startAt: number
	endAt: number
	categoryIds: string[]
	categoryNames: string[]
	channels: Channel[]
	drop?: DropReference
	serverMinutes?: number
}

export interface GlobalBadge {
	setID: string
	version: string | number
	title: string
	imageURL?: string
	user: unknown
}

export interface DropSelf {
	currentMinutesWatched: number
	isClaimed?: boolean
	dropInstanceID?: string | null
	hasPreconditionsMet?: boolean
}

export interface Drop {
	id: string
	requiredMinutesWatched: number
	startAt: string
	endAt: string
	requiredSubs?: number | null
	requiredTurboSubs?: number | null
	self?: DropSelf | null
	benefitEdges?: { benefit?: { name?: string | null } | null }[] | null
}

export interface Campaign {
	id: string
	startAt?: string
	endAt?: string
	game?: { id: string } | null
	timeBasedDrops?: Drop[] | null
}

export interface DropProgress extends DropSelf {
	requiredMinutesWatched: number
}

export interface Stream {
	id: string
	user_id: string
	user_login: string
	game_id: string
	game_name: string
	type: string
	viewer_count?: number
}

export interface SelectedStream extends Stream {
	drop: DropReference
}

export type AttemptStatus = 'pending' | 'watching' | 'earned' | 'waiting' | 'unconfirmed' | 'error' | 'expired-or-unavailable'

export interface Attempt {
	attemptedMs: number
	deferUntil: number
	status: AttemptStatus
	signature?: string
	serverMinutes?: number
}

export interface CollectorState {
	version: 1
	id: string
	confirmed: string[]
	attempts: Record<string, Attempt>
	active: string | null
}

declare global {
	interface Error {
		code?: string | number | undefined
		status?: number | undefined
		fatal?: boolean | undefined
		retryAfterMs?: number | undefined
	}
}
