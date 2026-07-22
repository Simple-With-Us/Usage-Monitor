import { createElement } from "react";
import { ImageResponse } from "next/og";

const SUPPORTED_SIZES = new Set([192, 512]);

export async function GET(
  _request: Request,
  context: { params: Promise<{ size: string }> }
) {
  const { size: rawSize } = await context.params;
  const size = Number(rawSize);
  if (!Number.isInteger(size) || !SUPPORTED_SIZES.has(size)) {
    return new Response("Not found", { status: 404 });
  }

  const icon = createElement(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #f97316 0%, #d97706 100%)",
        borderRadius: Math.round(size * 0.2),
      },
    },
    createElement(
      "svg",
      {
        width: Math.round(size * 0.68),
        height: Math.round(size * 0.68),
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "#ffffff",
        strokeWidth: 2,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      },
      createElement("path", {
        d: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z",
      })
    )
  );

  return new ImageResponse(icon, {
    width: size,
    height: size,
    headers: {
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
