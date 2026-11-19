import type { Campaign, DropProgress, DropsReward, RewardGroup, Task } from './types.ts'

// badges a group grants; a pool hands them out in order, one per completed day
export function rewardBadges(group: RewardGroup) {
	if (group.rewards?.length !== 1) return []

	const reward = group.rewards[0]!
	const items: DropsReward[] = reward.distributionType === 'POOL' ? (reward.pool?.rewards ?? []) : reward.pool == null ? [reward] : []
	const keys = items.map(item => {
		const badge = item.dropDetail?.badge

		return item.distributionType === 'BADGE' && badge?.setID && badge.version != null ? badge.setID + ':' + badge.version : ''
	})

	return keys.every(Boolean) ? keys : []
}

export function dailyProgress(group: RewardGroup, key: string, now = Date.now()): DropProgress | null {
	const criteria = group.progressCriteria
	const minutes = criteria?.requirements?.minutesWatched
	const repeats = criteria?.repeatableConfig
	const repeatable = repeats?.repeatableTimes
	const badges = rewardBadges(group)
	const pooled = group.rewards?.[0]?.distributionType === 'POOL'

	if (
		!badges.includes(key) ||
		criteria?.requirementType !== 'WATCH' ||
		criteria.requirements?.subs ||
		criteria.requirements?.turboSubs ||
		typeof minutes !== 'number' ||
		!Number.isSafeInteger(minutes) ||
		minutes <= 0 ||
		typeof repeatable !== 'number' ||
		!Number.isSafeInteger(repeatable) ||
		repeats?.resetIntervalSeconds !== 86400 ||
		(pooled
			? repeats.shouldCompleteAllRepeatsToEarn !== false || badges.length !== repeatable
			: repeats.shouldCompleteAllRepeatsToEarn !== true || repeatable <= 1)
	)
		return null

	const days = pooled ? badges.indexOf(key) + 1 : repeatable
	const self = group.self

	if (!self || self.hasPreconditionsMet !== true || !['IN_PROGRESS', 'CLAIMABLE', 'CLAIMED', 'FULFILLED'].includes(self.status)) return null

	// an unstarted group reports null minutes and no window on its channel
	const watched = self.currentMinutesWatched ?? (self.currentWindow ? NaN : 0)

	if (!Number.isFinite(watched) || watched < 0 || !Number.isSafeInteger(self.grantCount) || self.grantCount < 0 || self.grantCount > repeatable) {
		throw new Error('Twitch | Invalid daily reward counters')
	}

	const timestamp = (value: string | null | undefined) => {
		if (value == null) return null

		const time = Date.parse(value)

		if (!Number.isFinite(time)) throw new Error('Twitch | Invalid daily reward window')

		return time
	}

	const windowStartedAt = timestamp(self.currentWindow?.startedAt)
	const windowEndsAt = timestamp(self.currentWindow?.expiresAt)
	const nextEligibleAt = timestamp(self.nextEligibleAt)

	if (self.currentWindow && (windowStartedAt === null || windowEndsAt === null || windowStartedAt >= windowEndsAt))
		throw new Error('Twitch | Invalid daily reward window')

	return {
		// minutes outside an open window belong to a finished day
		currentMinutesWatched: windowEndsAt === null || windowEndsAt <= now ? 0 : watched,
		requiredMinutesWatched: minutes,
		hasPreconditionsMet: true,
		// a pool's earned reward may belong to an earlier day
		isClaimed: ['CLAIMED', 'FULFILLED'].includes(self.status) || (!pooled && !!self.earnedReward),
		daily: {
			requiredDays: days,
			completedDays: Math.min(self.grantCount, days),
			status: self.status,
			windowStartedAt,
			windowEndsAt,
			nextEligibleAt
		}
	}
}

export function matchesReward(task: Task, campaign: Campaign, group: RewardGroup, now = Date.now()) {
	const progress = dailyProgress(group, task.key, now)

	// the group is identified by the badge set id, so Twitch's minutes win over the catalog's; days must still agree
	return (
		!!progress &&
		progress.daily!.requiredDays === task.days &&
		(!campaign.startAt || Date.parse(campaign.startAt) <= now) &&
		(!campaign.endAt || Date.parse(campaign.endAt) > now)
	)
}
