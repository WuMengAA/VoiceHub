import { navigateTo } from '#app'

// 统一跳转守卫：同一跳转目标在窗口期内只允许触发一次，
// 消除「401 双跳 /login」「改密双跳 /change-password」等并发跳转竞争。
// 触发点：useErrorHandler.handle401Error、auth.global 中间件、auth.client 403 处理器等。
let lastLoginRedirectAt = 0
let lastPwRedirectAt = 0
const REDIRECT_DEBOUNCE_MS = 2000

/**
 * 跳转到登录页（2 秒窗口内去重）。
 * @param query 追加到 /login 的查询串，如 'error=SessionExpired' 或 'redirect=%2Fdashboard'
 */
export const redirectToLogin = (query = ''): ReturnType<typeof navigateTo> | void => {
  const now = Date.now()
  if (now - lastLoginRedirectAt < REDIRECT_DEBOUNCE_MS) {
    return
  }
  lastLoginRedirectAt = now
  const target = query ? `/login?${query}` : '/login'
  return navigateTo(target)
}

/** 跳转到强制改密页（2 秒窗口内去重） */
export const redirectToChangePassword = (): ReturnType<typeof navigateTo> | void => {
  const now = Date.now()
  if (now - lastPwRedirectAt < REDIRECT_DEBOUNCE_MS) {
    return
  }
  lastPwRedirectAt = now
  return navigateTo('/change-password')
}
