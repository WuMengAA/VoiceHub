import { useAuth } from '~/composables/useAuth'
import { redirectToLogin, redirectToChangePassword } from '~/utils/authRedirect'

export default defineNuxtRouteMiddleware(async (to, from) => {
  const { isAuthenticated, initAuth, user } = useAuth()
  const publicRoutes = ['/login', '/', '/auth/error', '/forgot-password', '/reset-password']

  // 客户端初始化认证状态
  let wasAuthenticated = false
  if (import.meta.client) {
    wasAuthenticated = isAuthenticated.value
    await initAuth()
    // initAuth 已因 401 清空认证态（Token 失效），跳转由下方统一守卫执行一次，
    // 短路避免本中间件继续走「未认证重定向」造成双跳 /login。
    if (wasAuthenticated && !isAuthenticated.value) {
      return redirectToLogin('error=SessionExpired')
    }
  }

  // 强制改密优先于公共页面判断，避免用户通过首页或直接输入地址绕过改密页。
  const passwordChangeRoutes = ['/change-password', '/login', '/forgot-password', '/reset-password']
  if (
    isAuthenticated.value &&
    user.value?.requirePasswordChange &&
    !passwordChangeRoutes.includes(to.path)
  ) {
    return redirectToChangePassword()
  }

  // 公共页面跳过认证
  if (publicRoutes.includes(to.path) || to.path.startsWith('/api/auth')) {
    return
  }

  // 服务端跳过认证检查
  if (import.meta.server) {
    return
  }

  // 未认证用户重定向到登录页（统一守卫，2s 去重）
  if (!isAuthenticated.value && to.path !== '/login') {
    // 保存目标路径用于登录后重定向
    const redirect = to.fullPath
    return redirectToLogin(`redirect=${encodeURIComponent(redirect)}`)
  }
})
