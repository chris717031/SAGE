// Supabase Edge Function: supabase/functions/xiaowei-rag-gateway/index.ts
// 功能：
// 1. 保護 GROQ_API_KEY（存放於 Supabase Secrets，前端完全零金鑰暴露）
// 2. mode = "rag_chat"：Grounded RAG 嚴格防幻覺生成（僅依據傳入之 Top-K 知識庫上下文回覆）
// 3. mode = "vision_diagnose"：多模態視覺辨識（自動判讀藍屏停止代碼、印表機面板燈號、讀卡機與 HIS 錯誤視窗）

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

// 視覺模型清單（依穩定度與多模態能力排序，自動備援）
const VISION_MODELS = [
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "llama-3.2-90b-vision-preview",
  "llama-3.2-11b-vision-preview",
];

serve(async (req: Request) => {
  // 處理瀏覽器 CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const groqApiKey = Deno.env.get("GROQ_API_KEY");
    if (!groqApiKey) {
      return new Response(
        JSON.stringify({
          error: "伺服器尚未設定 GROQ_API_KEY，請執行 supabase secrets set GROQ_API_KEY=gsk_...",
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const mode = body.mode || "rag_chat";

    // =========================================================================
    // 模式 A：多模態視覺診斷 (vision_diagnose) —— 自動辨識故障照片與錯誤碼
    // =========================================================================
    if (mode === "vision_diagnose") {
      const imageBase64 = body.imageBase64;
      const userHint = body.userHint || "";

      if (!imageBase64 || !String(imageBase64).startsWith("data:image/")) {
        return new Response(
          JSON.stringify({ error: "缺少有效的 Base64 圖片資料 (imageBase64)" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const visionPrompt = `你是企業與醫療院區的專業 IT 維護工程師助手「小威」。請仔細檢視使用者上傳的設備或螢幕故障照片，並嚴格輸出純 JSON 格式（不要包含 markdown \`\`\`json 標記或額外說明文字）：

{
  "device_type": "辨識出的設備或畫面類型（例如：Windows 藍屏 BSOD、標籤/條碼印表機、雷射印表機面板、健保讀卡機、HIS 醫療系統視窗、診間報到框體、網路線/燈號）",
  "error_code": "圖片上顯示的停止代碼、錯誤代碼或燈號狀態（例如：CRITICAL_PROCESS_DIED、0x0000007B、Paper Jam、紅燈閃爍；若無明確代碼請填 '無明確代碼'）",
  "error_text": "圖片上關鍵錯誤訊息的繁體中文摘要（若為英文錯誤請保留原文並附簡短中文翻譯，限 60 字內）",
  "search_query": "最適合拿去檢索院內 IT 知識庫的精準關鍵短語（例如：'電腦出現藍色畫面 BSOD'、'標籤條碼印表機無法列印 缺紙'、'健保讀卡機無法讀卡 紅燈'、'HIS系統無法開啟 錯誤訊息'）",
  "confidence": "high | medium | low"
}

使用者補充說明：${userHint || "無"}`;

      let lastVisionError = "";
      for (const modelName of VISION_MODELS) {
        try {
          const groqRes = await fetch(GROQ_CHAT_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${groqApiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: modelName,
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: visionPrompt },
                    { type: "image_url", image_url: { url: imageBase64 } },
                  ],
                },
              ],
              temperature: 0.1,
              max_tokens: 450,
            }),
          });

          if (!groqRes.ok) {
            const errTxt = await groqRes.text();
            lastVisionError = `[${modelName}] HTTP ${groqRes.status}: ${errTxt}`;
            continue;
          }

          const data = await groqRes.json();
          const rawContent = data.choices?.[0]?.message?.content?.trim() || "";

          // 嘗試解析結構化 JSON
          const cleanedJsonStr = rawContent
            .replace(/^```json\s*/i, "")
            .replace(/^```\s*/i, "")
            .replace(/```\s*$/i, "")
            .trim();

          let parsedResult = null;
          try {
            parsedResult = JSON.parse(cleanedJsonStr);
          } catch {
            // 若模型未嚴格輸出 JSON，擷取大括號區塊再試一次
            const braceMatch = cleanedJsonStr.match(/\{[\s\S]*\}/);
            if (braceMatch) {
              parsedResult = JSON.parse(braceMatch[0]);
            }
          }

          if (parsedResult && parsedResult.search_query) {
            return new Response(
              JSON.stringify({
                ok: true,
                model_used: modelName,
                diagnosis: {
                  device_type: parsedResult.device_type || "未知設備畫面",
                  error_code: parsedResult.error_code || "無明確代碼",
                  error_text: parsedResult.error_text || rawContent.slice(0, 80),
                  search_query: parsedResult.search_query,
                  confidence: parsedResult.confidence || "medium",
                },
              }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        } catch (err) {
          lastVisionError = String(err);
        }
      }

      return new Response(
        JSON.stringify({
          ok: false,
          error: "視覺模型辨識失敗",
          detail: lastVisionError,
        }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // =========================================================================
    // 模式 B：Grounded RAG 嚴格防幻覺對話生成 (rag_chat)
    // =========================================================================
    const combinedQuery = String(body.query || "").trim();
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    const isDef = Boolean(body.isDef);

    if (!combinedQuery) {
      return new Response(
        JSON.stringify({ error: "缺少查詢問題 (query)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let contextBlock = "（無相符的內部知識庫條目）";
    if (candidates.length > 0) {
      contextBlock = candidates
        .slice(0, 3)
        .map((c: Record<string, unknown>, idx: number) => {
          return `【參考條目 ${idx + 1}】
編號: ${c.sop_id || ""}
標題: ${c.title || ""}
審核狀態: ${c.status || "草稿待審"}
追問確認: ${c.followup_questions || "無"}
標準處理步驟: ${c.safe_steps || ""}
升級條件: ${c.escalation || "無"}`;
        })
        .join("\n\n---\n\n");
    }

    const systemPrompt = isDef
      ? `你是企業與醫療 IT 維護小助手「小威」。使用者正在詢問 IT 專有名詞概念。
【嚴格防幻覺規則】：
1. 若下方【內部參考資料】有說明，請優先依據資料用繁體中文白話解釋。
2. 若為通用 IT 基礎名詞（如 DNS、DHCP、IP），可用 2 段通俗白話解釋原理；但**嚴禁編造院內專屬網址、分機號碼或特定系統設定**。
3. 嚴禁輸出任何外部網頁連結。`
      : `你是企業與醫療 IT 維護小助手「小威」。請根據下方檢索到的【內部參考 SOP 資料】回答使用者的設備問題。

【嚴格防幻覺護欄（最高指導原則）】：
1. **絕對忠於檢索資料**：你**只能**使用下方【內部參考 SOP 資料】中明確記載的步驟與流程進行整合說明。
2. **禁止編造**：絕不可自行腦補或編造院內聯絡電話、分機、網址、系統選單代碼、指令或未出現在參考資料中的操作步驟。
3. **無相關資料時必須拒答**：如果下方【內部參考 SOP 資料】為空，或者與使用者的問題明顯無關，你**必須只回覆這四個字**：\`NO_MATCH\`，不要自行猜測解答！
4. **輸出格式**：若資料相關，請將最合適的排查動作整理為 2~4 個清晰步驟，每個步驟獨立成行並以「1. 」「2. 」「3. 」開頭。若資料內含「〔請填入〕」，請提醒使用者「此項目涉及院內特定設定，若不確定請直接點選報修」。`;

    const userPrompt = `【使用者對話與問題描述】：\n${combinedQuery}\n\n【內部參考 SOP 資料】：\n${contextBlock}`;

    const groqRes = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${groqApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        max_tokens: 700,
      }),
    });

    if (!groqRes.ok) {
      const errTxt = await groqRes.text();
      return new Response(
        JSON.stringify({ ok: false, error: `Groq API HTTP ${groqRes.status}`, detail: errTxt }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const data = await groqRes.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || "NO_MATCH";

    return new Response(
      JSON.stringify({
        ok: true,
        answer,
        grounded_sop_ids: candidates.slice(0, 3).map((c: Record<string, unknown>) => c.sop_id),
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
