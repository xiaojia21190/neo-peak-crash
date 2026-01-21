/**
 * Bets API
 * GET - 鑾峰彇鎶曟敞鍘嗗彶
 * POST/PUT - 宸茬鐢紙浣跨敤 WebSocket GameEngine锛? */

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getUserBetHistory } from "@/lib/services/user";

// 鑾峰彇鎶曟敞鍘嗗彶
export async function GET() {
  try {
    const session = await auth();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "鏈櫥褰? },
        { status: 401 }
      );
    }

    const history = await getUserBetHistory(session.user.id);
    return NextResponse.json({ bets: history });
  } catch (error) {
    console.error("鑾峰彇鎶曟敞鍘嗗彶澶辫触:", error);
    return NextResponse.json(
      { error: "鑾峰彇鎶曟敞鍘嗗彶澶辫触" },
      { status: 500 }
    );
  }
}

// 涓嬫敞 - 宸茬鐢紙璇蜂娇鐢?WebSocket GameEngine.placeBet锛?
export async function POST() {
  return NextResponse.json(
    { error: "姝?API 宸茬鐢ㄣ€傝閫氳繃 WebSocket GameEngine.placeBet() 涓嬫敞銆? },
    { status: 403 }
  );
}

// 缁撶畻 - 宸茬鐢紙鐢辨湇鍔＄娓告垙寮曟搸澶勭悊锛?
export async function PUT() {
  return NextResponse.json(
    { error: "姝?API 宸茬鐢ㄣ€傛姇娉ㄧ粨绠楃敱鏈嶅姟绔父鎴忓紩鎿庤嚜鍔ㄥ鐞嗐€? },
    { status: 403 }
  );
}
