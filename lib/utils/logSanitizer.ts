/**
 * 日志脱敏工具
 * 用于在打印日志前过滤或遮盖敏感信息
 */

// 需要完全隐藏的字段
const SENSITIVE_KEYS = new Set(['sign', 'key', 'secret', 'password', 'token', 'authorization']);

// 需要部分遮盖的字段（只显示前4位和后4位）
const PARTIAL_MASK_KEYS = new Set(['trade_no', 'out_trade_no', 'order_no', 'card_number']);

/**
 * 对日志参数进行脱敏处理
 * @param params 原始参数对象
 * @returns 脱敏后的参数对象
 */
export function sanitizeLogParams(params: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const lowerKey = key.toLowerCase();

    if (SENSITIVE_KEYS.has(lowerKey)) {
      continue; // 完全隐藏敏感字段
    }

    if (PARTIAL_MASK_KEYS.has(lowerKey) && value.length > 8) {
      // 只显示前4位和后4位
      sanitized[key] = `${value.slice(0, 4)}****${value.slice(-4)}`;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * 遮盖字符串中间部分
 * @param value 原始字符串
 * @param visibleChars 前后保留的字符数
 * @returns 遮盖后的字符串
 */
export function maskMiddle(value: string, visibleChars = 4): string {
  if (!value || value.length <= visibleChars * 2) {
    return value;
  }
  return `${value.slice(0, visibleChars)}****${value.slice(-visibleChars)}`;
}
