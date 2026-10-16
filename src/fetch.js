const REQUEST_TIMEOUT = 20_000

function networkReason(error) {
	const cause = error.cause?.errors?.[0] ?? error.cause ?? error
	const code = /^[A-Z0-9_]+$/.test(cause.code) ? cause.code : ''

	if (error.name === 'TimeoutError') return 'request timed out after 20s'
	if (/unexpected redirect/i.test(cause.message || '')) return 'redirect rejected'
	if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS lookup failed (' + code + ')'
	if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return 'connection closed (' + code + ')'
	if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return 'connection timed out (' + code + ')'
	if (code === 'ECONNREFUSED') return 'connection refused (ECONNREFUSED)'

	return 'network request failed' + (code ? ' (' + code + ')' : '')
}

export async function fetchResponse(url, { label = 'HTTP', fatalAuth = false, allowedStatuses = [], ...options } = {}) {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT)
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
	const context = (options.method || 'GET') + ' ' + new URL(url).hostname

	let response

	try {
		response = await fetch(url, { ...options, signal, redirect: 'error' })
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason

		const reason = timeout.aborted ? 'request timed out after 20s' : networkReason(error)

		throw new Error(label + ': ' + reason + ' [' + context + ']')
	}

	if (!response.ok && !allowedStatuses.includes(response.status)) {
		await response.body?.cancel()

		const error = new Error(label + ': HTTP ' + response.status + ' [' + context + ']')
		const retryAfter = response.headers.get('retry-after')
		const seconds = Number(retryAfter)

		error.status = response.status
		error.fatal = fatalAuth && [401, 403].includes(response.status)
		if (error.fatal) error.message += ', run npm run gen-token'
		error.retryAfterMs = Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) || 0

		throw error
	}

	return response
}

export async function fetchJson(url, options = {}) {
	const response = await fetchResponse(url, options)

	try {
		return await response.json()
	} catch {
		if (options.signal?.aborted) throw options.signal.reason

		throw new Error((options.label || 'HTTP') + ': invalid or incomplete JSON response')
	}
}

export async function fetchText(url, options = {}) {
	const response = await fetchResponse(url, options)

	try {
		return await response.text()
	} catch (error) {
		if (options.signal?.aborted) throw options.signal.reason

		throw new Error((options.label || 'HTTP') + ': ' + networkReason(error) + ' while reading response')
	}
}
