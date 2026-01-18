/**
 * 游戏引擎错误类
 */

export class GameError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'GameError';
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
    };
  }
}
