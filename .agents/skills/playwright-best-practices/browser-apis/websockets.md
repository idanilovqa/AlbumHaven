# WebSocket & Real-Time Testing

## Table of Contents

1. [WebSocket Basics](#websocket-basics)
2. [Mocking WebSocket Messages](#mocking-websocket-messages)
3. [Testing Real-Time Features](#testing-real-time-features)
4. [Server-Sent Events](#server-sent-events)
5. [Reconnection Testing](#reconnection-testing)

## WebSocket Basics

### Wait for WebSocket Connection

```typescript
test("chat connects via websocket", async ({ page }) => {
  // Listen for WebSocket connection
  const wsPromise = page.waitForEvent("websocket");

  await page.goto("/chat");

  const ws = await wsPromise;
  expect(ws.url()).toContain("/ws/chat");

  // Wait for connection to be established
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
});
```

### Monitor WebSocket Messages

```typescript
test("receives real-time updates", async ({ page }) => {
  const messages: string[] = [];

  // Set up listener before navigation
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => {
      messages.push(frame.payload as string);
    });
  });

  await page.goto("/dashboard");

  // Wait for some messages
  await expect.poll(() => messages.length).toBeGreaterThan(0);

  // Verify message format
  const data = JSON.parse(messages[0]);
  expect(data).toHaveProperty("type");
});
```

### Capture Sent Messages

```typescript
test("sends correct message format", async ({ page }) => {
  const sentMessages: string[] = [];

  page.on("websocket", (ws) => {
    ws.on("framesent", (frame) => {
      sentMessages.push(frame.payload as string);
    });
  });

  await page.goto("/chat");
  await page.getByLabel("Message").fill("Hello!");
  await page.getByRole("button", { name: "Send" }).click();

  // Verify sent message
  await expect.poll(() => sentMessages.length).toBeGreaterThan(0);

  const sent = JSON.parse(sentMessages[sentMessages.length - 1]);
  expect(sent).toEqual({
    type: "message",
    content: "Hello!",
  });
});
```

## Mocking WebSocket Messages

### Inject Messages via Page Evaluate

```typescript
test("displays incoming chat message", async ({ page }) => {
  await page.goto("/chat");

  // Wait for WebSocket to be ready
  await page.waitForFunction(
    () => (window as any).chatSocket?.readyState === 1,
  );

  // Simulate incoming message
  await page.evaluate(() => {
    const event = new MessageEvent("message", {
      data: JSON.stringify({
        type: "message",
        from: "Alice",
        content: "Hello there!",
      }),
    });
    (window as any).chatSocket.dispatchEvent(event);
  });

  await expect(page.getByText("Alice: Hello there!")).toBeVisible();
});
```

### Mock WebSocket with Route Handler

Use Playwright's WebSocket routing before navigation. The browser keeps its native
WebSocket object, including normal `open`, `message`, and `close` listeners.

```typescript
test("mock websocket entirely", async ({ page }) => {
  let connection: import("@playwright/test").WebSocketRoute | undefined;
  await page.routeWebSocket("**/ws/chat", socket => {
    connection = socket;
    socket.onMessage(message => {
      const payload = JSON.parse(String(message));
      socket.send(JSON.stringify({ type: "message", from: "You", content: payload.content }));
    });
  });

  await page.goto("/chat");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  expect(connection).toBeDefined();
  connection!.send(JSON.stringify({ type: "message", from: "Alice", content: "Hello there!" }));
  await expect(page.getByText("Alice: Hello there!")).toBeVisible();

  await page.getByLabel("Message").fill("Hello Alice!");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("You: Hello Alice!")).toBeVisible();
});
```

The route is a mock server because it does not call `connectToServer()`. See the
[WebSocketRoute API](https://playwright.dev/docs/api/class-websocketroute).
This is isolated frontend coverage; it does not verify backend WebSocket delivery.

### WebSocket Mock Fixture

```typescript
// fixtures/websocket.fixture.ts
import { test as base, Page } from "@playwright/test";

type WsMessage = { type: string; [key: string]: any };

type WebSocketFixtures = {
  mockWebSocket: {
    injectMessage: (message: WsMessage) => Promise<void>;
    getSentMessages: () => Promise<WsMessage[]>;
  };
};

export const test = base.extend<WebSocketFixtures>({
  mockWebSocket: async ({ page }, use) => {
    const sentMessages: WsMessage[] = [];

    // Capture sent messages
    await page.addInitScript(() => {
      (window as any).__wsSent = [];
      const OriginalWebSocket = window.WebSocket;
      window.WebSocket = function (url: string) {
        const ws = new OriginalWebSocket(url);
        const originalSend = ws.send.bind(ws);
        ws.send = (data: string) => {
          (window as any).__wsSent.push(JSON.parse(data));
          originalSend(data);
        };
        (window as any).__ws = ws;
        return ws;
      } as any;
    });

    await use({
      injectMessage: async (message) => {
        await page.evaluate((msg) => {
          const event = new MessageEvent("message", {
            data: JSON.stringify(msg),
          });
          (window as any).__ws?.dispatchEvent(event);
        }, message);
      },
      getSentMessages: async () => {
        return page.evaluate(() => (window as any).__wsSent || []);
      },
    });
  },
});

// Usage
test("chat with mocked websocket", async ({ page, mockWebSocket }) => {
  await page.goto("/chat");

  // Inject incoming message
  await mockWebSocket.injectMessage({
    type: "message",
    from: "Bob",
    content: "Hi!",
  });

  await expect(page.getByText("Bob: Hi!")).toBeVisible();

  // Send a reply
  await page.getByLabel("Message").fill("Hello Bob!");
  await page.getByRole("button", { name: "Send" }).click();

  // Verify sent message
  const sent = await mockWebSocket.getSentMessages();
  expect(sent).toContainEqual(
    expect.objectContaining({ content: "Hello Bob!" }),
  );
});
```

## Testing Real-Time Features

### Live Notifications

```typescript
test("displays live notification", async ({ page }) => {
  await page.goto("/dashboard");

  // Simulate notification via WebSocket
  await page.evaluate(() => {
    const event = new MessageEvent("message", {
      data: JSON.stringify({
        type: "notification",
        title: "New Order",
        message: "Order #123 received",
      }),
    });
    (window as any).notificationSocket.dispatchEvent(event);
  });

  await expect(page.getByRole("alert")).toContainText("Order #123 received");
});
```

### Live Data Updates

```typescript
test("updates stock price in real-time", async ({ page }) => {
  await page.goto("/stocks/AAPL");

  const priceElement = page.getByTestId("stock-price");
  const initialPrice = await priceElement.textContent();

  // Simulate price update
  await page.evaluate(() => {
    const event = new MessageEvent("message", {
      data: JSON.stringify({
        type: "price_update",
        symbol: "AAPL",
        price: 150.25,
      }),
    });
    (window as any).stockSocket.dispatchEvent(event);
  });

  await expect(priceElement).not.toHaveText(initialPrice!);
  await expect(priceElement).toContainText("150.25");
});
```

### Collaborative Editing

```typescript
test("shows collaborator cursor", async ({ page }) => {
  await page.goto("/document/123");

  // Simulate another user's cursor position
  await page.evaluate(() => {
    const event = new MessageEvent("message", {
      data: JSON.stringify({
        type: "cursor",
        userId: "user-456",
        userName: "Alice",
        position: { x: 100, y: 200 },
      }),
    });
    (window as any).docSocket.dispatchEvent(event);
  });

  await expect(page.getByTestId("cursor-user-456")).toBeVisible();
  await expect(page.getByText("Alice")).toBeVisible();
});
```

## Server-Sent Events

### Test SSE Updates

```typescript
test("receives SSE updates", async ({ page }) => {
  // Mock SSE endpoint
  await page.route("**/api/events", (route) => {
    route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
      body: `data: {"type":"update","value":42}\n\n`,
    });
  });

  await page.goto("/live-data");

  await expect(page.getByTestId("value")).toHaveText("42");
});
```

### Simulate Multiple SSE Events

```typescript
test("handles multiple SSE events", async ({ page }) => {
  await page.route("**/api/events", async (route) => {
    const encoder = new TextEncoder();
    const events = [
      `data: {"count":1}\n\n`,
      `data: {"count":2}\n\n`,
      `data: {"count":3}\n\n`,
    ];

    route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
      body: events.join(""),
    });
  });

  await page.goto("/counter");

  // Should receive all events
  await expect(page.getByTestId("count")).toHaveText("3");
});
```

## Reconnection Testing

### Test Connection Loss

```typescript
test("handles connection loss gracefully", async ({ page }) => {
  await page.goto("/chat");

  // Simulate connection close
  await page.evaluate(() => {
    (window as any).chatSocket.close();
  });

  // Should show disconnected state
  await expect(page.getByText("Reconnecting...")).toBeVisible();
});
```

### Test Reconnection

```typescript
test("reconnects after connection loss", async ({ page }) => {
  const connections: import("@playwright/test").WebSocketRoute[] = [];
  await page.routeWebSocket("**/ws/chat", socket => {
    connections.push(socket);
    // Keep a real browser WebSocket and its normal application listeners.
    socket.onMessage(message => {
      const payload = JSON.parse(String(message));
      socket.send(JSON.stringify({ type: "message", from: "You", content: payload.content }));
    });
  });
  await page.goto("/chat");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  expect(connections).toHaveLength(1);

  // A server-side close exercises the application's real reconnect loop.
  await connections[0].close({ code: 1012, reason: "Service restart" });
  await expect.poll(() => connections.length).toBe(2);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("After reconnect");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("You: After reconnect")).toBeVisible();
});
```

## Anti-Patterns to Avoid

| Anti-Pattern                          | Problem                       | Solution                           |
| ------------------------------------- | ----------------------------- | ---------------------------------- |
| Not waiting for WebSocket ready       | Messages sent too early       | Wait for `readyState === 1`        |
| Testing against real WebSocket server | Flaky, timing-dependent       | Mock WebSocket messages            |
| Ignoring connection state             | Tests pass but feature broken | Test connected/disconnected states |
| No cleanup of listeners               | Memory leaks in tests         | Clean up event listeners           |

## Related References

- **Network**: See [network-advanced.md](../advanced/network-advanced.md) for HTTP mocking patterns
- **Assertions**: See [assertions-waiting.md](../core/assertions-waiting.md) for polling patterns
- **Multi-User**: See [multi-user.md](../advanced/multi-user.md) for real-time collaboration testing with multiple users
