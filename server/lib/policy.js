/**
 * Market server — authorization policy. THE authority.
 *
 * The DSH-side plugin makes no decisions; it asks this module (through the HTTP
 * API) and obeys. One evaluation order, used by catalog, detail, download and
 * install alike, so the four entry points cannot drift apart:
 *
 *   1. no session                 -> E_NOT_LOGGED_IN
 *   2. account not active         -> E_ACCOUNT_DISABLED
 *   3. must change password       -> E_MUST_CHANGE_PASSWORD
 *   4. no group membership        -> E_NO_GROUP           (default deny)
 *   5. any matching deny grant    -> E_FORBIDDEN_DENY     (deny wins)
 *   6. no matching allow grant    -> E_FORBIDDEN_NO_GRANT
 *   7. channel not granted        -> E_CHANNEL_NOT_GRANTED
 *   8. artifact not published     -> E_NOT_PUBLISHED / E_REVOKED
 *   9. otherwise                  -> allowed
 */

export function evaluate(store, caller, artifact) {
  if (!caller) return { allowed: false, code: 'E_NOT_LOGGED_IN' }
  const { user, mustChangePassword } = caller

  if (user.status !== 'active') return { allowed: false, code: 'E_ACCOUNT_DISABLED' }
  if (mustChangePassword) return { allowed: false, code: 'E_MUST_CHANGE_PASSWORD' }

  const groups = store.groupsOf(user.username)
  if (groups.length === 0) {
    return { allowed: false, code: 'E_NO_GROUP', detail: '账号未加入任何权限组（默认拒绝）' }
  }

  const grants = store.grantsFor(groups, artifact.name)

  const denied = grants.filter((grant) => grant.effect === 'deny')
  if (denied.length > 0) {
    return {
      allowed: false,
      code: 'E_FORBIDDEN_DENY',
      detail: `被规则拒绝：${denied.map((grant) => grant.pluginPattern).join(', ')}`,
    }
  }

  const allowed = grants.filter((grant) => grant.effect === 'allow')
  if (allowed.length === 0) {
    return { allowed: false, code: 'E_FORBIDDEN_NO_GRANT', detail: '没有任何规则授予该插件' }
  }

  const channel = artifact.channel ?? 'stable'
  if (!allowed.some((grant) => !grant.channel || grant.channel === channel)) {
    return { allowed: false, code: 'E_CHANNEL_NOT_GRANTED', detail: `未授予 ${channel} 通道` }
  }

  /**
   * Recall implies "do not distribute" — it would be absurd to ask clients to remove something
   * while still handing it out.
   *
   * The DISTINCT code matters: the client tells the user why it is removing something, and
   * 「被召回」 is a different message from 「已被撤回」.
   */
  if (artifact.recalled === true) return { allowed: false, code: 'E_RECALLED' }
  if (artifact.status === 'revoked') return { allowed: false, code: 'E_REVOKED' }
  if (artifact.status !== 'published') {
    return { allowed: false, code: 'E_NOT_PUBLISHED', detail: `状态为 ${artifact.status}` }
  }

  return { allowed: true, code: null, via: allowed.map((grant) => grant.pluginPattern) }
}

/** Status code for a verdict: 401 only when the caller must authenticate. */
export function statusFor(code) {
  if (code === 'E_NOT_LOGGED_IN') return 401
  if (code === 'E_NOT_FOUND') return 404
  return 403
}
