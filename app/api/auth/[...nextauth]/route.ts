/**
 * NextAuth API 路由处理器
 * 处理 OAuth 认证回调
 */

import { handlers } from "@/lib/auth";

export const { GET, POST } = handlers;
