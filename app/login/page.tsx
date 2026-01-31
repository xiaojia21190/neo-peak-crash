"use client";

import { Suspense } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

function LoginContent() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/";

  const handleLogin = () => {
    signIn("linux-do", { callbackUrl });
  };

  return (
    <div className="max-w-md w-full space-y-8 p-8 bg-gray-800/50 backdrop-blur-sm rounded-xl border border-gray-700">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-white mb-2">Neon Peak</h1>
        <p className="text-gray-400">登录以开始游戏</p>
      </div>

      <div className="space-y-4">
        <button onClick={handleLogin} className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors duration-200 flex items-center justify-center gap-2">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clipRule="evenodd" />
          </svg>
          使用 Linux DO 登录
        </button>

        <p className="text-sm text-gray-500 text-center">登录即表示您同意我们的服务条款和隐私政策</p>
      </div>
    </div>
  );
}

function LoginFallback() {
  return (
    <div className="max-w-md w-full space-y-8 p-8 bg-gray-800/50 backdrop-blur-sm rounded-xl border border-gray-700 animate-pulse">
      <div className="text-center">
        <div className="h-10 bg-gray-700 rounded w-48 mx-auto mb-2"></div>
        <div className="h-4 bg-gray-700 rounded w-32 mx-auto"></div>
      </div>
      <div className="space-y-4">
        <div className="h-12 bg-gray-700 rounded"></div>
        <div className="h-4 bg-gray-700 rounded w-3/4 mx-auto"></div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-linear-to-br from-gray-900 via-gray-800 to-black">
      <Suspense fallback={<LoginFallback />}>
        <LoginContent />
      </Suspense>
    </div>
  );
}
