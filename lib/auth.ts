/**
 * Linux DO OAuth2 认证配置
 * 基于 NextAuth v5 (Auth.js)
 * 文档: https://connect.linux.do
 */

import NextAuth from "next-auth";

/**
 * Linux DO OAuth2 Provider 配置
 * 用户信息字段参考文档:
 * - id: 用户唯一标识（不可变）
 * - username: 论坛用户名
 * - name: 论坛用户昵称（可变）
 * - avatar_template: 用户头像模板URL（支持多种尺寸）
 * - active: 账号活跃状态
 * - trust_level: 信任等级（0-4）
 * - silenced: 禁言状态
 */
const LinuxDoProvider = {
  id: "linux-do",
  name: "Linux DO",
  type: "oauth" as const,
  authorization: {
    url: process.env.LINUXDO_AUTHORIZATION_URL || "https://connect.linux.do/oauth2/authorize",
    params: { scope: "user" },
  },
  token: {
    url: process.env.LINUXDO_TOKEN_URL || "https://connect.linux.do/oauth2/token",
  },
  userinfo: {
    url: process.env.LINUXDO_USERINFO_URL || "https://connect.linux.do/api/user",
  },
  clientId: process.env.LINUXDO_CLIENT_ID,
  clientSecret: process.env.LINUXDO_CLIENT_SECRET,
  // 禁用 PKCE - Linux DO OAuth 服务器不支持
  checks: ["state"] as ("state" | "none" | "pkce")[],
  profile(profile: {
    id: number;
    username: string;
    name?: string;
    avatar_template?: string;
    active?: boolean;
    trust_level?: number;
    silenced?: boolean;
  }) {
    // 处理头像URL模板，替换 {size} 为实际尺寸
    const avatarUrl = profile.avatar_template
      ? profile.avatar_template.replace("{size}", "120")
      : undefined;

    // Linux DO 的用户 ID（数字）转为字符串
    const linuxDoId = String(profile.id);

    return {
      id: linuxDoId,
      name: profile.name || profile.username,
      email: `${profile.username}@linux.do`,
      image: avatarUrl,
      // 自定义字段
      linuxDoId,
      username: profile.username,
      trustLevel: profile.trust_level ?? 0,
      active: profile.active ?? true,
      silenced: profile.silenced ?? false,
    };
  },
};

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    // Linux DO OAuth2 登录（仅在配置了相关环境变量时启用）
    ...(process.env.LINUXDO_CLIENT_ID && process.env.LINUXDO_CLIENT_SECRET
      ? [LinuxDoProvider]
      : []),
  ],
  callbacks: {
    async jwt({ token, user, account }) {
      if (user) {
        // 获取自定义字段 linuxDoId
        const linuxDoId = (user as { linuxDoId?: string }).linuxDoId;

        // 使用 linuxDoId 作为稳定的用户 ID
        const stableUserId = linuxDoId || account?.providerAccountId || user.id;

        // 设置 token 中的用户 ID
        token.id = stableUserId;
        token.sub = stableUserId;

        // 保存 OAuth 用户的额外信息
        if (account?.provider === "linux-do") {
          const username = (user as { username?: string }).username;
          token.username = username;
          token.trustLevel = (user as { trustLevel?: number }).trustLevel;
          token.provider = "linux-do";
          token.image = user.image;
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        // 将 token 中的信息传递到 session
        session.user.id = token.id as string;
        (session.user as { username?: string }).username = token.username as string;
        (session.user as { trustLevel?: number }).trustLevel = token.trustLevel as number;
        (session.user as { provider?: string }).provider = token.provider as string;
        session.user.image = token.image as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  // Vercel 部署必需：信任代理主机
  trustHost: true,
  // Cookie 配置 - 解决 PKCE 验证问题
  cookies: {
    pkceCodeVerifier: {
      name: "next-auth.pkce.code_verifier",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
    state: {
      name: "next-auth.state",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
});

// 导出类型
export type AuthUser = {
  id: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
  username?: string;
  trustLevel?: number;
  provider?: string;
};
