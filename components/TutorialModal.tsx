"use client";

import React, { useState, useEffect } from "react";

interface TutorialModalProps {
  isOpen: boolean;
  onClose: () => void;
  houseEdge: number; // 庄家抽水率
}

const TUTORIAL_STEPS = [
  {
    title: "🎮 欢迎来到 PingooTread",
    content: (
      <div className="space-y-4">
        <p className="text-gray-300">
          这是一款基于<span className="text-indigo-400 font-bold">实时加密货币价格</span>的预测游戏。
        </p>
        <p className="text-gray-300">
          价格数据来自 <span className="text-yellow-400">Bybit</span> 交易所的实时行情。
        </p>
        <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4 mt-4">
          <p className="text-indigo-300 text-sm">💡 提示：游戏结果完全取决于真实市场价格波动，无法预测或操控。</p>
        </div>
      </div>
    ),
  },
  {
    title: "📊 如何下注",
    content: (
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <span className="font-bold">1</span>
          </div>
          <div>
            <p className="text-white font-bold">点击 "Start Cycle" 开始游戏</p>
            <p className="text-gray-400 text-sm">锁定当前价格作为基准点</p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <span className="font-bold">2</span>
          </div>
          <div>
            <p className="text-white font-bold">在网格上点击下注</p>
            <p className="text-gray-400 text-sm">选择你预测价格会经过的格子</p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
            <span className="font-bold">3</span>
          </div>
          <div>
            <p className="text-white font-bold">等待价格线经过</p>
            <p className="text-gray-400 text-sm">如果价格线穿过你下注的格子，你就赢了！</p>
          </div>
        </div>
      </div>
    ),
  },
  {
    title: "💰 倍率计算",
    content: (
      <div className="space-y-4">
        <p className="text-gray-300">
          倍率基于<span className="text-green-400 font-bold">高斯分布</span>计算：
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-3 text-center">
            <div className="text-2xl font-black text-green-400">1.01x</div>
            <div className="text-xs text-gray-400">中心区域（最容易命中）</div>
          </div>
          <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-3 text-center">
            <div className="text-2xl font-black text-yellow-400">2-5x</div>
            <div className="text-xs text-gray-400">中等距离</div>
          </div>
          <div className="bg-orange-500/10 border border-orange-500/20 rounded-xl p-3 text-center">
            <div className="text-2xl font-black text-orange-400">10-30x</div>
            <div className="text-xs text-gray-400">较远距离</div>
          </div>
          <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-3 text-center">
            <div className="text-2xl font-black text-red-400">50-100x</div>
            <div className="text-xs text-gray-400">极端区域（最难命中）</div>
          </div>
        </div>
        <div className="bg-purple-500/10 border border-purple-500/20 rounded-xl p-4 mt-2">
          <p className="text-purple-300 text-sm">
            ⏱️ <span className="font-bold">时间奖励</span>：下注越早（预测越远的未来），倍率越高！每秒增加约 4% 倍率。
          </p>
        </div>
      </div>
    ),
  },
  {
    title: "🎯 游戏模式",
    content: (
      <div className="space-y-4">
        <div className="bg-purple-500/10 border border-purple-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-2xl">🎮</span>
            <span className="text-purple-400 font-black">游玩模式</span>
          </div>
          <ul className="text-gray-300 text-sm space-y-1">
            <li>• 使用模拟 LDC（初始 10,000）</li>
            <li>• 不消耗真实积分</li>
            <li>• 适合练习和熟悉玩法</li>
            <li>• 可随时重置余额</li>
          </ul>
        </div>
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-2xl">⚡</span>
            <span className="text-yellow-400 font-black">真实模式</span>
          </div>
          <ul className="text-gray-300 text-sm space-y-1">
            <li>• 使用真实 LDC 积分</li>
            <li>• 需要先充值 LDC</li>
            <li>• 赢取的 LDC 可提现</li>
            <li>• 需要登录 Linux DO 账号</li>
          </ul>
        </div>
      </div>
    ),
  },
  {
    title: "⚠️ 风险提示",
    content: (houseEdge: number) => (
      <div className="space-y-4">
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
          <p className="text-red-400 font-bold mb-2">请注意以下风险：</p>
          <ul className="text-gray-300 text-sm space-y-2">
            <li className="flex items-start gap-2">
              <span className="text-red-400">•</span>
              <span>
                本游戏包含 <span className="text-red-400 font-bold">{(houseEdge * 100).toFixed(0)}% 庄家优势</span>，长期来看庄家必胜
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-red-400">•</span>
              <span>请勿投入超过你能承受损失的金额</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-red-400">•</span>
              <span>游戏仅供娱乐，请理性参与</span>
            </li>
          </ul>
        </div>
        <div className="bg-indigo-500/10 border border-indigo-500/20 rounded-xl p-4">
          <p className="text-indigo-300 text-sm">
            💡 建议：先使用<span className="text-purple-400 font-bold">游玩模式</span>熟悉玩法，再决定是否使用真实 LDC。
          </p>
        </div>
      </div>
    ),
  },
];

export function TutorialModal({ isOpen, onClose, houseEdge }: TutorialModalProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  const handleNext = () => {
    if (currentStep < TUTORIAL_STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleClose();
    }
  };

  const handlePrev = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleClose = () => {
    if (dontShowAgain) {
      localStorage.setItem("tutorial_completed", "true");
    }
    onClose();
  };

  const step = TUTORIAL_STEPS[currentStep];
  const content = typeof step.content === "function" ? step.content(houseEdge) : step.content;

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[100]" onClick={handleClose} />

      {/* Modal */}
      <div className="fixed inset-0 flex items-center justify-center z-[101] p-4">
        <div className="bg-[#1a1a24] border border-white/10 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
          {/* Header */}
          <div className="bg-gradient-to-r from-indigo-600/20 to-purple-600/20 px-6 py-4 border-b border-white/5">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-black text-white">{step.title}</h2>
              <button onClick={handleClose} className="text-gray-400 hover:text-white transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            {/* Progress */}
            <div className="flex gap-1 mt-3">
              {TUTORIAL_STEPS.map((_, idx) => (
                <div key={idx} className={`h-1 flex-1 rounded-full transition-colors ${idx <= currentStep ? "bg-indigo-500" : "bg-white/10"}`} />
              ))}
            </div>
          </div>

          {/* Content */}
          <div className="px-6 py-6 min-h-[280px]">{content}</div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-white/5 flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={dontShowAgain} onChange={(e) => setDontShowAgain(e.target.checked)} className="w-4 h-4 rounded border-white/20 bg-white/5 text-indigo-600 focus:ring-indigo-500" />
              <span className="text-xs text-gray-400">不再显示</span>
            </label>

            <div className="flex gap-2">
              {currentStep > 0 && (
                <button onClick={handlePrev} className="px-4 py-2 text-sm font-bold text-gray-400 hover:text-white transition-colors">
                  上一步
                </button>
              )}
              <button onClick={handleNext} className="px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-xl transition-colors">
                {currentStep === TUTORIAL_STEPS.length - 1 ? "开始游戏" : "下一步"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
