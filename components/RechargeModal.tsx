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
      <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50" onClick={onClose} />

      {/* 弹窗内容 */}
      <div className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-slate-900/95 backdrop-blur-xl border border-slate-700/50 rounded-2xl shadow-2xl z-50 overflow-hidden">
        {/* 标题 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/50">
          <h2 className="text-lg font-heading font-black text-white">充值 LDC 积分</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-800/50 transition-colors duration-200 cursor-pointer">
            <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-6">
          {/* 预设金额 */}
          <div>
            <label className="block text-[10px] font-heading font-bold text-slate-500 uppercase tracking-wider mb-3">选择充值金额</label>
            <div className="grid grid-cols-5 gap-2">
              {PRESET_AMOUNTS.map((value) => (
                <button
                  key={value}
                  onClick={() => handlePresetClick(value)}
                  className={`py-3 rounded-xl font-heading font-bold text-sm transition-all duration-200 cursor-pointer ${
                    amount === value && !customAmount
                      ? "bg-cta text-white shadow-lg shadow-cta/30"
                      : "bg-slate-800/50 text-slate-400 hover:bg-slate-700/50 hover:text-slate-200 border border-slate-700/50"
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          {/* 自定义金额 */}
          <div>
            <label className="block text-[10px] font-heading font-bold text-slate-500 uppercase tracking-wider mb-2">或输入自定义金额</label>
            <div className="relative">
              <input
                type="number"
                value={customAmount}
                onChange={handleCustomChange}
                placeholder="输入金额 (1-10000)"
                min="1"
                max="10000"
                className="w-full bg-slate-800/50 border border-slate-700/50 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:border-cta focus:ring-1 focus:ring-cta transition-colors duration-200"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-primary font-heading font-bold text-sm">LDC</span>
            </div>
          </div>

          {/* 当前选择 */}
          <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700/50 backdrop-blur-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 text-sm">充值金额</span>
              <span className="text-2xl font-heading font-black text-primary">
                {amount.toFixed(2)} <span className="text-sm">LDC</span>
              </span>
            </div>
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-slate-700/50">
              <span className="text-slate-500 text-xs">支付方式</span>
              <span className="text-cta text-xs font-heading font-bold">Linux DO Credit</span>
            </div>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-red-400 text-sm backdrop-blur-sm">
              {error}
            </div>
          )}

          {/* 提交按钮 */}
          <button
            onClick={handleSubmit}
            disabled={isLoading || amount < 1}
            className={`w-full py-4 rounded-xl font-heading font-black text-sm uppercase tracking-wider transition-all duration-200 ${
              isLoading || amount < 1
                ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                : "bg-cta hover:bg-cta-light text-white shadow-lg shadow-cta/30 active:scale-[0.98] cursor-pointer"
            }`}
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                处理中...
              </span>
            ) : (
              `确认充值 ${amount.toFixed(2)} LDC`
            )}
          </button>

          {/* 提示 */}
          <p className="text-center text-[10px] text-slate-500">充值将跳转到 Linux DO Credit 平台完成支付</p>
        </div>
      </div>
    </>
  );
}
