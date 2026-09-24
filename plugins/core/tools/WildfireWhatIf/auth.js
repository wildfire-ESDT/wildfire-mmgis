// Keycloak authentication for the Wildfire What-If tool (Direct Access
// Grant, i.e. the password flow). This gates the tool UI only: the token is
// kept in sessionStorage for reload survival and refreshed before expiry,
// but is not attached to veloserver or MMGIS requests.

import useWhatIfStore from './store'
import { loadHistory, exitRunView, hideScenario, restoreScenario, clearPerimeter } from './actions'

const S = useWhatIfStore

const STORAGE_KEY = 'ww-kc-session'
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

export function login(username, password) {
    const s = S.getState()
    const gen = ++authGen
    S.setState({ authBusy: true, authError: null })
    return fetch(`${tokenEndpoint()}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'password',
            client_id: s.kcClientId,
            scope: 'openid',
            username,
            password,
        }),
    })
        .then((r) =>
            r.json().then((data) => {
                if (gen !== authGen) return
                if (r.ok) {
                    applyTokens(data)
                    return
                }
                let msg
                if (/not fully set up/i.test(data.error_description || '')) {
                    // Keycloak's default user profile requires email, first
                    // and last name; accounts missing them fail this way.
                    msg =
                        'Account setup is incomplete. Ask an admin to fill in the email and name fields for this user.'
                } else if (data.error === 'invalid_grant') {
                    msg = 'Invalid username or password.'
                } else {
                    msg =
                        data.error_description ||
                        data.error ||
                        `Login failed (HTTP ${r.status}).`
                }
                S.setState({ authBusy: false, authError: msg })
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
