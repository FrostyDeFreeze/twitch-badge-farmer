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
	kind?: 'reward-group'
}

export interface Task {
	key: string
	title: string
	rewardNames: string[]
	availabilityId?: string | number | undefined
	minutes: number
	days?: number
	daily?: DailyProgress
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
	rewardGroups?: RewardGroup[] | null
}

export interface DailyProgress {
	requiredDays: number
	completedDays: number
	status: string
	windowStartedAt: number | null
	windowEndsAt: number | null
	nextEligibleAt: number | null
}

export interface RewardGroup {
	id: string
	track?: string | null
	lane?: string | null
	progressCriteria?: {
		requirementType?: string
		requirements?: { minutesWatched?: number; subs?: number | null; turboSubs?: number | null }
		repeatableConfig?: { repeatableTimes?: number; resetIntervalSeconds?: number; shouldCompleteAllRepeatsToEarn?: boolean }
	}
	self?: {
		status: string
		currentMinutesWatched: number | null
		grantCount: number
		nextEligibleAt?: string | null
		currentWindow?: { startedAt: string; expiresAt: string } | null
		hasPreconditionsMet?: boolean
		earnedReward?: { id: string } | null
	} | null
	rewards?: { distributionType?: string; dropDetail?: { badge?: { setID?: string; version?: string | number } | null } | null; pool?: unknown }[]
}

export interface DropProgress extends DropSelf {
	requiredMinutesWatched: number
	daily?: DailyProgress
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

export type AttemptStatus =
	'pending' | 'watching' | 'earned' | 'waiting' | 'waiting-day' | 'waiting-progress' | 'unconfirmed' | 'error' | 'expired-or-unavailable'

export interface Attempt {
	attemptedMs: number
	deferUntil: number
	status: AttemptStatus
	signature?: string
	dailyWindow?: string
	dailyCompletedDays?: number
	dailyCompletedWindow?: string
	claimedInstance?: string
	claimPendingAt?: number
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
