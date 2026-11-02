// Keycloak authentication for the Wildfire What-If tool (Authorization Code
// flow with PKCE). The user signs in on Keycloak's own page, so this code never
// sees a password; it only trades a one-time code for tokens. This gates the
// tool UI only: the token is
// kept in sessionStorage for reload survival and refreshed before expiry,
// but is not attached to veloserver or MMGIS requests.

import useWhatIfStore from './store'
import { loadHistory, exitRunView, hideScenario, restoreScenario, clearPerimeter } from './actions'

const S = useWhatIfStore

const STORAGE_KEY = 'ww-kc-session'
const PKCE_KEY = 'ww-kc-pkce'
// Query params Keycloak appends to the redirect back; stripped from the URL.
const CALLBACK_PARAMS = ['code', 'state', 'session_state', 'iss', 'error', 'error_description']
const REFRESH_EARLY_MS = 60000

let refreshTimer = null
// Bumped on every login/logout/expiry. A token response from an older auth
// generation (a refresh in flight during logout, a slow login answered after
// the user gave up) is dropped instead of signing someone back in.
let authGen = 0

function tokenEndpoint() {
    const s = S.getState()
    const base = s.kcUrl.replace(/\/$/, '')
    return `${base}/realms/${encodeURIComponent(s.kcRealm)}/protocol/openid-connect`
}

// ── PKCE ───────────────────────────────────────────────

function randomString(bytes) {
    const a = new Uint8Array(bytes)
    crypto.getRandomValues(a)
    return base64Url(a)
}

function base64Url(bytes) {
    let bin = ''
    bytes.forEach((b) => (bin += String.fromCharCode(b)))
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function challengeFor(verifier) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
    return base64Url(new Uint8Array(digest))
}

// Where Keycloak sends the user back to: this page without any callback
// params. Must be listed in the client's Valid Redirect URIs.
function currentRedirectUri() {
    const u = new URL(window.location.href)
    CALLBACK_PARAMS.forEach((p) => u.searchParams.delete(p))
    u.hash = ''
    return u.toString()
}

function readPkce() {
    try {
        return JSON.parse(sessionStorage.getItem(PKCE_KEY))
    } catch (e) {
        return null
    }
}

function clearPkce() {
    try {
        sessionStorage.removeItem(PKCE_KEY)
    } catch (e) {}
}

// Decode a JWT payload without verification. Verification is the server's
// job; here the token only tells the UI who signed in.
function jwtPayload(token) {
    try {
        const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
        return JSON.parse(atob(b64))
    } catch (e) {
        return {}
    }
}

function saveSession(session) {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    } catch (e) {}
}

function clearSession() {
    if (refreshTimer) {
        clearTimeout(refreshTimer)
        refreshTimer = null
    }
    try {
        sessionStorage.removeItem(STORAGE_KEY)
    } catch (e) {}
}

function readSession() {
    try {
        return JSON.parse(sessionStorage.getItem(STORAGE_KEY))
    } catch (e) {
        return null
    }
}

function applyTokens(data) {
    const payload = jwtPayload(data.access_token)
    const user = payload.preferred_username || payload.name || 'user'
    // `sub` is the stable per-user key; username is kept only for display.
    const userId = payload.sub || null
    const session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (data.expires_in || 300) * 1000,
        user,
        userId,
    }
    saveSession(session)
    scheduleRefresh(session)
    const wasLoggedIn = S.getState().loggedIn
    S.setState({
        loggedIn: true,
        authUser: user,
        authUserId: userId,
        authError: null,
        authBusy: false,
    })
    if (!wasLoggedIn) {
        loadHistory()
        restoreScenario()
    }
}

function scheduleRefresh(session) {
    if (refreshTimer) clearTimeout(refreshTimer)
    const delay = Math.max(session.expires_at - Date.now() - REFRESH_EARLY_MS, 5000)
    refreshTimer = setTimeout(() => refresh(session.refresh_token), delay)
}

function refresh(refreshToken) {
    if (!refreshToken) return expire()
    const s = S.getState()
    const gen = authGen
    fetch(`${tokenEndpoint()}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: s.kcClientId,
            refresh_token: refreshToken,
        }),
    })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('refresh failed'))))
        .then((data) => {
            if (gen === authGen) applyTokens(data)
        })
        .catch(() => {
            if (gen === authGen) expire()
        })
}

// Clears auth state plus the previous user's in-memory runs so the next
// login starts from its own history.
function signedOutState(authError) {
    return {
        loggedIn: false,
        authUser: null,
        authUserId: null,
        authError,
        authBusy: false,
        jobs: {},
        jobIds: [],
        activeJobId: null,
        page: 0,
    }
}

// The draft is kept so the same user can sign back in and carry on, but it
// comes off the map while the login gate is up.
function expire() {
    authGen++
    clearSession()
    exitRunView()
    hideScenario()
    S.setState(signedOutState('Session expired. Sign in again.'))
}

// Send the user to Keycloak's login page. Returns after navigation starts.
export async function login() {
    const s = S.getState()
    S.setState({ authBusy: true, authError: null })
    try {
        const verifier = randomString(48)
        const state = randomString(24)
        const redirectUri = currentRedirectUri()
        sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, redirectUri }))
        const params = new URLSearchParams({
            client_id: s.kcClientId,
            response_type: 'code',
            scope: 'openid',
            redirect_uri: redirectUri,
            state,
            code_challenge: await challengeFor(verifier),
            code_challenge_method: 'S256',
        })
        window.location.assign(`${tokenEndpoint()}/auth?${params}`)
    } catch (err) {
        S.setState({
            authBusy: false,
            authError: 'Could not start sign-in. ' + err.message,
        })
    }
}

// True when this page load is Keycloak redirecting back to us.
export function isLoginCallback() {
    const q = new URLSearchParams(window.location.search)
    return !!readPkce() && q.has('state') && (q.has('code') || q.has('error'))
}

// Finish a sign-in: validate state, scrub the URL, trade the code for tokens.
function completeLogin() {
    const q = new URLSearchParams(window.location.search)
    const pkce = readPkce()
    const code = q.get('code')
    const state = q.get('state')
    const kcError = q.get('error_description') || q.get('error')

    // The code is single-use; get it out of the address bar and history.
    const clean = new URL(window.location.href)
    CALLBACK_PARAMS.forEach((p) => clean.searchParams.delete(p))
    window.history.replaceState(null, '', clean.toString())
    clearPkce()

    if (!pkce || state !== pkce.state) {
        S.setState({ authBusy: false, authError: 'Sign-in could not be verified. Try again.' })
        return
    }
    if (kcError || !code) {
        S.setState({ authBusy: false, authError: kcError || 'Sign-in was cancelled.' })
        return
    }

    const s = S.getState()
    const gen = ++authGen
    S.setState({ authBusy: true, authError: null })
    fetch(`${tokenEndpoint()}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: s.kcClientId,
            code,
            redirect_uri: pkce.redirectUri,
            code_verifier: pkce.verifier,
        }),
    })
        .then((r) =>
            r.json().then((data) => {
                if (gen !== authGen) return
                if (r.ok) {
                    applyTokens(data)
                    return
                }
                S.setState({
                    authBusy: false,
                    authError:
                        data.error_description || data.error || `Login failed (HTTP ${r.status}).`,
                })
            })
        )
        .catch((err) => {
            if (gen !== authGen) return
            S.setState({
                authBusy: false,
                authError: 'Could not reach the login server. ' + err.message,
            })
        })
}

// Rehydrate a previous session on tool open so a page reload doesn't log
// the user out. Expired sessions are refreshed if possible, else dropped.
export function restoreSession() {
    if (isLoginCallback()) return completeLogin()
    const session = readSession()
    if (!session || !session.access_token) return
    if (session.expires_at - Date.now() > REFRESH_EARLY_MS) {
        scheduleRefresh(session)
        const wasLoggedIn = S.getState().loggedIn
        S.setState({
            loggedIn: true,
            authUser: session.user,
            authUserId: session.userId || null,
            authError: null,
        })
        if (!wasLoggedIn) loadHistory()
    } else {
        refresh(session.refresh_token)
    }
}

export function logout() {
    const s = S.getState()
    const session = readSession()
    if (session && session.refresh_token) {
        // Best effort: invalidate the session server-side too
        fetch(`${tokenEndpoint()}/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: s.kcClientId,
                refresh_token: session.refresh_token,
            }),
        }).catch(() => {})
    }
    authGen++
    clearSession()
    // The next person to sign in on this browser starts from a clean map
    exitRunView()
    clearPerimeter()
    S.setState(signedOutState(null))
}
