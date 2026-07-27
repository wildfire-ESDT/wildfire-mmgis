import React, { useState } from 'react'
import useWhatIfStore from '../store'
import ToolController_ from '@basics/ToolController_/ToolController_'
import { IconButton } from '@design/components'

export default function LoginGate({ children }) {
    const loggedIn = useWhatIfStore((s) => s.loggedIn)
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')

    if (loggedIn) return children

    function handleLogin(e) {
        e.preventDefault()
        if (!username.trim()) {
            setError('Please enter a username.')
            return
        }
        // Placeholder: auto-approve any credentials
        useWhatIfStore.setState({ loggedIn: true })
    }

    return (
        <div id="wildfireTool" className="mmgisScrollbar">
            <div className="mmgisToolHeader">
                <div>
                    <div>
                        <div className="mmgisToolTitle">
                            Wildfire Scenario Forecast
                        </div>
                    </div>
                    <div>
                        <IconButton
                            size="sm"
                            onClick={() => ToolController_.closeActiveTool()}
                            title="Close Tool"
                        >
                            <i className="mdi mdi-close mdi-18px" />
                        </IconButton>
                    </div>
                </div>
            </div>

            <form className="ww-login-form" onSubmit={handleLogin}>
                <div className="ww-login-logo">
                    <i className="mdi mdi-fire mdi-36px" style={{ color: '#ff6b35' }} />
                </div>
                <div className="ww-login-title">Sign in to continue</div>
                {error && (
                    <div className="ww-status ww-status-err">{error}</div>
                )}
                <div className="ww-login-field">
                    <label className="ww-login-label" htmlFor="ww-username">
                        Username
                    </label>
                    <input
                        id="ww-username"
                        className="ww-login-input"
                        type="text"
                        autoComplete="username"
                        placeholder="Enter username"
                        value={username}
                        onChange={(e) => {
                            setUsername(e.target.value)
                            setError('')
                        }}
                    />
                </div>
                <div className="ww-login-field">
                    <label className="ww-login-label" htmlFor="ww-password">
                        Password
                    </label>
                    <input
                        id="ww-password"
                        className="ww-login-input"
                        type="password"
                        autoComplete="current-password"
                        placeholder="Enter password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </div>
                <button type="submit" className="ww-full ww-submit ww-login-btn">
                    Log In
                </button>
                <div className="ww-login-hint">
                    Access restricted to authorized personnel.
                </div>
            </form>
        </div>
    )
}
