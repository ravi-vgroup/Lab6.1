import "dotenv/config";

export async function triggerFlow({ handle, payload }) {
  if (!handle?.trim()) {
    throw new Error("Flow handle is required.");
  }

  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!storeDomain) {
    throw new Error("Missing SHOPIFY_STORE_DOMAIN in .env");
  }

  if (!accessToken) {
    throw new Error("Missing SHOPIFY_ACCESS_TOKEN in .env");
  }

  const response = await fetch(
    `https://${storeDomain}/admin/api/2025-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `
          mutation TriggerFlow($handle: String!, $payload: JSON!) {
            flowTriggerReceive(handle: $handle, payload: $payload) {
              userErrors {
                field
                message
              }
            }
          }
        `,
        variables: {
          handle,
          payload,
        },
      }),
    }
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(
      `Shopify Flow trigger failed: ${response.status} ${JSON.stringify(result)}`
    );
  }

  const flowResult = result?.data?.flowTriggerReceive;
  if (!flowResult) {
    throw new Error(`Shopify Flow trigger returned no data: ${JSON.stringify(result)}`);
  }

  if (flowResult.userErrors?.length) {
    throw new Error(JSON.stringify(flowResult.userErrors));
  }

  return flowResult;
}

export async function requestOrderReview({ orderId, reason, role, confirmed }) {
  if (!orderId?.trim()) {
    throw new Error("orderId is required.");
  }

  if (!reason?.trim()) {
    throw new Error("reason is required.");
  }

  const { requireApproval } = await import("./approval.js");
  requireApproval({ role, confirmed });

  return triggerFlow({
    handle: "order-review-requested",
    payload: {
      order_id: orderId,
      reason,
    },
  });
}
