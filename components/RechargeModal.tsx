"use client";

import React, { useState } from "react";

interface RechargeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (amount: number) => void;
}

const PRESET_AMOUNTS = [10, 50, 100, 500, 1000];

export function RechargeModal({ isOpen, onClose, onSuccess }: RechargeModalProps) {
  const [amount, setAmount] = useState<number>(100);
  const [customAmount, setCustomAmount] = useState<string>("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handlePresetClick = (value: number) => {
    setAmount(value);
    setCustomAmount("");
    setError(null);
  };

  const handleCustomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setCustomAmount(value);
    const num = parseFloat(value);
    if (!isNaN(num) && num > 0) {
      setAmount(num);
      setError(null);
    }
  };

  const handleSubmit = async () => {
    if (amount < 1 || amount > 10000) {
      setError("充值金额需在 1-10000 之间");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/payment/recharge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount }),
      });

      const result = await response.json();

      if (!result.success) {
        setError(result.error || "创建订单失败");
        return;
      }

      // 创建表单并提交跳转到支付页面
      if (result.paymentForm) {
        const form = document.createElement("form");
        form.method = "POST";
        form.action = result.paymentForm.actionUrl;
        form.style.display = "none";

        Object.entries(result.paymentForm.params).forEach(([key, value]) => {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = key;
          input.value = String(value);
          form.appendChild(input);
        });

        document.body.appendChild(form);
        form.submit();
      }
    } catch (err) {
      setError("网络错误，请重试");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {/* 背景遮罩 */}
      <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-modal" onClick={onClose} />

      {/* 弹窗内容 */}
      <div className="fixed inset-0 flex items-center justify-center z-modal-content p-4 pointer-events-none">
        <div className="w-full max-w-md bg-slate-900/95 backdrop-blur-xl border border-slate-700/50 rounded-2xl shadow-2xl overflow-hidden pointer-events-auto flex flex-col max-h-[90vh]">
          {/* 标题 */}
          <div className="bg-linear-to-r from-cta/20 to-purple-500/20 px-6 py-4 border-b border-slate-700/50 shrink-0">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-heading font-black text-white">充值 LDC 积分</h2>
              <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-all duration-200 cursor-pointer">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* 内容 - 可滚动区域 */}
          <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar">
            {/* 预设金额 */}
            <div>
              <label className="block text-xs font-heading font-bold text-slate-400 uppercase tracking-wider mb-3">选择充值金额</label>
              <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
                {PRESET_AMOUNTS.map((value) => (
                  <button
                    key={value}
                    onClick={() => handlePresetClick(value)}
                    className={`py-3 rounded-xl font-heading font-bold text-sm transition-all duration-200 cursor-pointer border relative overflow-hidden group ${
                      amount === value && !customAmount ? "bg-cta border-cta text-white shadow-lg shadow-cta/30 ring-2 ring-cta/30 ring-offset-1 ring-offset-slate-900" : "bg-slate-800/50 border-slate-700/50 text-slate-400 hover:bg-slate-700/80 hover:text-slate-200 hover:border-slate-600"
                    }`}
                  >
                    <span className="relative z-10">{value}</span>
                    {/* Hover Glow Effect */}
                    <div className="absolute inset-0 bg-linear-to-tr from-white/0 via-white/5 to-white/0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none" />
                  </button>
                ))}
              </div>
            </div>

            {/* 自定义金额 */}
            <div>
              <label className="block text-xs font-heading font-bold text-slate-400 uppercase tracking-wider mb-3">或输入自定义金额</label>
              <div className="relative group">
                <input
                  type="number"
                  inputMode="decimal"
                  pattern="[0-9]*"
                  value={customAmount}
                  onChange={handleCustomChange}
                  placeholder="输入金额 (1-10000)"
                  min="1"
                  max="10000"
                  className="w-full bg-slate-800/50 border border-slate-700/50 rounded-xl pl-4 pr-16 py-4 text-white placeholder-slate-500 focus:outline-none focus:border-cta focus:ring-1 focus:ring-cta transition-all duration-200 font-heading font-medium"
                />
                <div className="absolute right-4 top-1/2 -translate-y-1/2 flex items-center gap-2 pointer-events-none">
                  <span className="text-slate-600 text-sm">|</span>
                  <span className="text-primary font-heading font-bold text-sm text-shadow-glow">LDC</span>
                </div>
              </div>
            </div>

            {/* 当前选择 */}
            <div className="bg-linear-to-br from-slate-800/50 to-slate-800/20 rounded-xl p-5 border border-slate-700/50 backdrop-blur-sm relative overflow-hidden">
              <div className="absolute top-0 right-0 w-32 h-32 bg-primary/5 rounded-full blur-2xl -mr-10 -mt-10 pointer-events-none" />

              <div className="flex items-end justify-between relative z-10">
                <div className="space-y-1">
                  <span className="text-slate-500 text-xs uppercase tracking-wider font-bold">实际支付金额</span>
                  <div className="flex items-center gap-2 text-slate-400 text-xs">
                    <span>1 LDC = 1 CNY</span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="block text-3xl font-heading font-black text-white leading-none tracking-tight">{amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                  <span className="text-cta text-xs font-heading font-bold uppercase tracking-wider mt-1 block">Linux DO Credit</span>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-slate-700/30 flex items-center justify-between text-xs relative z-10">
                <span className="text-slate-500">支付方式</span>
                <span className="flex items-center gap-1.5 text-slate-300 font-medium">
                  <svg className="w-3.5 h-3.5 text-cta" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm.31-8.86c-1.77-.45-2.34-.94-2.34-1.67 0-.84.79-1.43 2.1-1.43 1.38 0 1.9.66 1.94 1.64h1.71c-.05-1.34-.87-2.57-2.49-2.97V5H10.9v1.69c-1.51.32-2.72 1.3-2.72 2.81 0 1.79 1.49 2.69 3.66 3.21 1.95.46 2.34 1.15 2.34 1.87 0 .53-.39 1.39-2.1 1.39-1.6 0-2.23-.72-2.32-1.64H8.04c.1 1.7 1.36 2.66 2.86 2.97V19h2.34v-1.67c1.52-.29 2.72-1.16 2.73-2.77-.01-2.2-1.9-2.96-3.66-3.42z" />
                  </svg>
                  Linux DO Connect
                </span>
              </div>
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm backdrop-blur-sm flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {error}
              </div>
            )}

            {/* 提示 */}
            <div className="flex items-start gap-2 px-2">
              <svg className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-xs text-slate-500 leading-relaxed">
                充值将跳转到 Linux DO Credit 平台，支付成功后自动返回并到账。
                <span className="text-slate-400 block mt-1">请确保您的浏览器允许弹出窗口。</span>
              </p>
            </div>
          </div>

          {/* 底部操作栏 */}
          <div className="p-6 border-t border-slate-700/50 bg-slate-900/50 backdrop-blur-md shrink-0">
            <button
              onClick={handleSubmit}
              disabled={isLoading || amount < 1}
              className={`w-full py-4 rounded-xl font-heading font-black text-sm uppercase tracking-widest transition-all duration-300 relative overflow-hidden group ${
                isLoading || amount < 1 ? "bg-slate-800 text-slate-500 cursor-not-allowed" : "bg-cta hover:bg-cta-light text-white shadow-lg shadow-cta/25 hover:shadow-cta/40 hover:-translate-y-0.5 active:translate-y-0 active:shadow-md cursor-pointer"
              }`}
            >
              <div className="relative z-10 flex items-center justify-center gap-2">
                {isLoading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>处理中...</span>
                  </>
                ) : (
                  <>
                    <span>立即充值</span>
                    <span className="opacity-80 font-normal ml-0.5">¥{amount.toFixed(2)}</span>
                    <svg className="w-4 h-4 group-hover:translate-x-1 transition-transform duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
                    </svg>
                  </>
                )}
              </div>
              {/* Shine Effect */}
              {!isLoading && amount >= 1 && <div className="absolute top-0 -left-full w-1/2 h-full bg-linear-to-r from-transparent via-white/20 to-transparent skew-x-[-20deg] group-hover:animate-shine" />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
