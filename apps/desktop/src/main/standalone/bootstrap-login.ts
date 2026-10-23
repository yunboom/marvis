// 单机模式主机管理员的一次性登录：服务端就绪后，用启动时生成的 token 换取登录凭证。

const BOOTSTRAP_PATH = "/auth/bootstrap";
const BOOTSTRAP_TIMEOUT_MS = 15_000;

// 服务端约定：token 已用过时返回 410。
const STATUS_TOKEN_USED = 410;

// bootstrap 登录失败；tokenUsed 为 true 时需要重启服务端换一个新 token 才能再登录。
export class BootstrapLoginError extends Error {
  constructor(
    message: string,
    readonly tokenUsed: boolean,
  ) {
    super(message);
  }
}

export async function bootstrapLogin(
  baseUrl: string,
  token: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${BOOTSTRAP_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, email }),
      signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new BootstrapLoginError(`bootstrap login: ${err instanceof Error ? err.message : String(err)}`, false);
  }
  if (!res.ok) {
    throw new BootstrapLoginError(`bootstrap login: HTTP ${res.status}`, res.status === STATUS_TOKEN_USED);
  }

  const body: unknown = await res.json().catch(() => null);
  const sessionToken =
    body && typeof body === "object" && "token" in body && typeof (body as { token: unknown }).token === "string"
      ? (body as { token: string }).token
      : "";
  if (!sessionToken) throw new BootstrapLoginError("bootstrap login: response has no token", false);

  return sessionToken;
}
