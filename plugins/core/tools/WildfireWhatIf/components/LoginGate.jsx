import React from 'react'
import useWhatIfStore from '../store'
import ToolController_ from '@basics/ToolController_/ToolController_'
import { IconButton } from '@design/components'
import { login } from '../auth'

export default function LoginGate({ children }) {
    const loggedIn = useWhatIfStore((s) => s.loggedIn)
    const authBusy = useWhatIfStore((s) => s.authBusy)
    const authError = useWhatIfStore((s) => s.authError)

    if (loggedIn) return children

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

            <div className="ww-login-form">
                <div className="ww-login-logo">
                    <i className="mdi mdi-fire mdi-36px" style={{ color: '#ff6b35' }} />
                </div>
                <div className="ww-login-title">Sign in to continue</div>
                {authError && (
                    <div className="ww-status ww-status-err">{authError}</div>
                )}
                <button
                    type="button"
                    className="ww-full ww-submit ww-login-btn"
                    disabled={authBusy}
                    onClick={() => login()}
                >
                    {authBusy ? 'Signing in…' : 'Log In'}
                </button>
                <div className="ww-login-hint">
                    You will be taken to the secure sign-in page. This is a
                    resource intensive operation.
                </div>
            </div>
        </div>
    )
}
