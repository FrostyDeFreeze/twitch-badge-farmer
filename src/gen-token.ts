import example from '../config.example.json'

interface DeviceResponse {
	device_code: string
	user_code: string
	expires_in: number
	interval?: number
}

interface TokenResponse {
	access_token?: unknown
	message?: string
	error?: string
}

interface TokenIdentity {
	client_id?: string
	user_id: string
	login: string
}

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { setTimeout as pause } from 'node:timers/promises'
import { readConfig, validateConfig } from './config.ts'
import { fetchJson, fetchResponse } from './fetch.ts'
import { createLogger } from './logger.ts'

export async function generateToken(configPath: string, signal?: AbortSignal, log = createLogger()) {
	const clientId = typeof example?.client_id === 'string' ? example.client_id.trim() : ''

	if (!clientId) throw new Error('config.example.json requires a Client ID')

	// use the same device flow as TwitchDropsMiner without requesting scopes
	const device = await fetchJson<DeviceResponse>('https://id.twitch.tv/oauth2/device', {
		method: 'POST',
		signal,
		label: 'OAuth device code',
		body: new URLSearchParams({ client_id: clientId, scopes: '' })
	})

	if (
		typeof device?.device_code !== 'string' ||
		!device.device_code ||
		typeof device.user_code !== 'string' ||
		!/^[A-Z0-9]{4,16}$/i.test(device.user_code) ||
		!Number.isFinite(device.expires_in) ||
		device.expires_in <= 0
	) {
		throw new Error('OAuth: invalid device authorization response')
	}

	const expiresAt = Date.now() + device.expires_in * 1000
	let interval = Number.isFinite(device.interval) ? Math.max(5, device.interval!) * 1000 : 5000
	const activation = new URL('https://www.twitch.tv/activate')
	activation.searchParams.set('device-code', device.user_code)
	signal?.throwIfAborted()

	log.info('Open ' + activation.href)
	log.info('Activation code: ' + device.user_code)
	log.debug('[AUTH] No additional scopes requested')
	log.log({ tag: 'WAIT', message: 'Waiting for Twitch authorization | Ctrl+C to cancel' })

	const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
	const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', activation.href] : [activation.href]
	const browser = spawn(command, args, { stdio: 'ignore', windowsHide: true })

	browser.on('error', () => log.warn('Could not open the browser | Use the link above'))
	browser.unref()

	let token: string | undefined

	while (Date.now() < expiresAt) {
		await pause(Math.min(interval, expiresAt - Date.now()), undefined, { signal })
		if (Date.now() >= expiresAt) break

		let response

		try {
			response = await fetchResponse('https://id.twitch.tv/oauth2/token', {
				method: 'POST',
				signal,
				label: 'OAuth token',
				allowedStatuses: [400],
				body: new URLSearchParams({
					client_id: clientId,
					device_code: device.device_code,
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
				})
			})
		} catch (error) {
			if (!(error instanceof Error)) throw error

			if (error.status !== 429) throw error

			interval = Math.max(interval + 5000, error.retryAfterMs || 0)
			continue
		}

		let result: TokenResponse

		try {
			result = (await response.json()) as TokenResponse
		} catch {
			throw new Error('OAuth: invalid token response')
		}

		if (response.ok) {
			if (typeof result?.access_token !== 'string' || !/^[a-z0-9]+$/i.test(result.access_token)) {
				throw new Error('OAuth: missing access token')
			}
			token = result.access_token
			break
		}

		const reason = result?.message || result?.error

		if (reason === 'authorization_pending') continue
		if (reason === 'slow_down') {
			interval += 5000
			continue
		}
		if (reason === 'access_denied') throw new Error('OAuth: authorization denied, config unchanged')
		if (['expired_token', 'invalid device code'].includes(reason || '')) break

		throw new Error('OAuth: authorization rejected, run with --gen-token again')
	}

	if (!token) throw new Error('OAuth: activation code expired, run with --gen-token again')

	const data = await fetchJson<TokenIdentity>('https://id.twitch.tv/oauth2/validate', {
		headers: { Authorization: 'OAuth ' + token },
		fatalAuth: true,
		signal,
		label: 'OAuth token details'
	})

	if (data?.client_id !== clientId) throw new Error('OAuth: token Client ID mismatch, config unchanged')

	// allow zero expiry reported by TV tokens
	const user = { id: data.user_id, login: data.login }

	if (!/^\d+$/.test(user?.id) || typeof user?.login !== 'string' || !/^[a-z0-9_]+$/i.test(user.login)) {
		throw new Error('Twitch: missing account identity, config unchanged')
	}

	let existing

	try {
		existing = await readConfig(configPath)
	} catch (error) {
		if (!(error instanceof Error)) throw error

		if (error.code !== 'ENOENT') throw error
		existing = {}
	}

	if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('Invalid config JSON, original file preserved')
	const existingId = String(('id' in existing ? existing.id : '') ?? '').trim()

	if (/^\d+$/.test(existingId) && existingId !== user.id) {
		throw new Error('Authorized account differs from config, sign in with the original account, config unchanged')
	}

	const config = { ...existing, ...validateConfig({ id: user.id, login: user.login, client_id: clientId, token }) }
	const temp = configPath + '.' + randomUUID() + '.tmp'

	signal?.throwIfAborted()

	try {
		await writeFile(temp, JSON.stringify(config, null, '\t') + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true })
		await rename(temp, configPath)
	} catch (error) {
		if (!(error instanceof Error)) throw error

		throw new Error('Could not save config (' + error.code + '), original file preserved')
	} finally {
		await unlink(temp).catch(error => {
			if (error.code !== 'ENOENT') throw error
		})
	}

	log.success('Config saved for ' + config.login + ' | Start the collector')
}
