import type { Campaign, DropProgress, RewardGroup, Task } from './types.ts'

export function rewardBadgeKey(group: RewardGroup) {
	if (group.rewards?.length !== 1) return

	const reward = group.rewards[0]!
	const badge = reward.dropDetail?.badge

	if (reward.distributionType !== 'BADGE' || reward.pool != null || !badge?.setID || badge.version == null) return

	return badge.setID + ':' + badge.version
}

export function dailyProgress(group: RewardGroup, now = Date.now()): DropProgress | null {
	const criteria = group.progressCriteria
	const minutes = criteria?.requirements?.minutesWatched
	const repeats = criteria?.repeatableConfig
	const days = repeats?.repeatableTimes

	if (
		criteria?.requirementType !== 'WATCH' ||
		criteria.requirements?.subs ||
		criteria.requirements?.turboSubs ||
		typeof minutes !== 'number' ||
		!Number.isSafeInteger(minutes) ||
		minutes <= 0 ||
		typeof days !== 'number' ||
		!Number.isSafeInteger(days) ||
		days <= 1 ||
		repeats?.resetIntervalSeconds !== 86400 ||
		repeats.shouldCompleteAllRepeatsToEarn !== true
	)
		return null

	const self = group.self

	if (!self || self.hasPreconditionsMet !== true || !['IN_PROGRESS', 'CLAIMABLE', 'CLAIMED', 'FULFILLED'].includes(self.status)) return null

	// an unstarted group reports null minutes and no window on its channel
	const watched = self.currentMinutesWatched ?? (self.currentWindow ? NaN : 0)

	if (!Number.isFinite(watched) || watched < 0 || !Number.isSafeInteger(self.grantCount) || self.grantCount < 0 || self.grantCount > days) {
		throw new Error('Twitch: invalid daily reward counters')
	}

	const timestamp = (value: string | null | undefined) => {
		if (value == null) return null

		const time = Date.parse(value)

		if (!Number.isFinite(time)) throw new Error('Twitch: invalid daily reward window')

		return time
	}

	const windowStartedAt = timestamp(self.currentWindow?.startedAt)
	const windowEndsAt = timestamp(self.currentWindow?.expiresAt)
	const nextEligibleAt = timestamp(self.nextEligibleAt)

	if (self.currentWindow && (windowStartedAt === null || windowEndsAt === null || windowStartedAt >= windowEndsAt))
		throw new Error('Twitch: invalid daily reward window')

	return {
		currentMinutesWatched: windowEndsAt !== null && windowEndsAt <= now ? 0 : watched,
		requiredMinutesWatched: minutes,
		hasPreconditionsMet: true,
		isClaimed: ['CLAIMED', 'FULFILLED'].includes(self.status) || !!self.earnedReward,
		daily: { requiredDays: days, completedDays: self.grantCount, status: self.status, windowStartedAt, windowEndsAt, nextEligibleAt }
	}
}

export function matchesReward(task: Task, campaign: Campaign, group: RewardGroup, now = Date.now()) {
	const progress = dailyProgress(group, now)

	return (
		rewardBadgeKey(group) === task.key &&
		!!progress &&
		progress.requiredMinutesWatched === task.minutes &&
		progress.daily!.requiredDays === task.days &&
		(!campaign.startAt || Date.parse(campaign.startAt) <= now) &&
		(!campaign.endAt || Date.parse(campaign.endAt) > now)
	)
}
