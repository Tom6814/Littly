/** 鉴权端点：注册 / 登录 / 登出 / 会话。 */
import type { UserRow } from '@littly/storage'
import { json, err, bodyRecord, reqStr } from './http.ts'
import { createUser, verifyPassword } from './auth.ts'
import { userView } from './mapping.ts'
import type { RegisterFn } from './deps.ts'

export const registerAuthRoutes: RegisterFn = (r, d) => {
  r.post('/api/auth/register', 'public', (ctx) => {
    const body = bodyRecord(ctx.body)
    const username = reqStr(body, 'username', 'name')
    const password = reqStr(body, 'password', 'pass')
    if (username === undefined || password === undefined) {
      err(ctx.res, 400, 'bad_request', '用户名和密码不能为空')
      return
    }
    const created = createUser(d.storage, username, password)
    if ('error' in created) {
      err(ctx.res, 400, 'register_failed', created.error)
      return
    }
    d.sessions.setCookie(ctx.res, created.user.id, created.user.role)
    json(ctx.res, 200, { data: { user: userView(created.user as UserRow) } })
  })

  r.post('/api/auth/login', 'public', (ctx) => {
    const body = bodyRecord(ctx.body)
    const username = reqStr(body, 'username', 'name')
    const password = reqStr(body, 'password', 'pass')
    if (username === undefined || password === undefined) {
      err(ctx.res, 400, 'bad_request', '用户名和密码不能为空')
      return
    }
    const row = d.storage.prepare('SELECT * FROM users WHERE username = ?').get(username.trim()) as UserRow | undefined
    if (row === undefined || !verifyPassword(password, row.password_hash)) {
      err(ctx.res, 401, 'invalid_credentials', '用户名或密码错误')
      return
    }
    d.sessions.setCookie(ctx.res, row.id, row.role)
    json(ctx.res, 200, { data: { user: userView(row) } })
  })

  r.post('/api/auth/logout', 'public', (ctx) => {
    d.sessions.clearCookie(ctx.res)
    json(ctx.res, 200, { data: { ok: true } })
  })

  r.get('/api/auth/session', 'public', (ctx) => {
    if (ctx.user === null) {
      err(ctx.res, 401, 'unauthorized', '未登录')
      return
    }
    json(ctx.res, 200, { data: { user: userView(ctx.user) } })
  })
}
