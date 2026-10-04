import {
  negotiateProviderCapabilities,
  type ProviderEvent,
  type ProviderRegistration,
} from "@getpaseo/plugin/server/provider";

/** Test-only provider. Every prompt produces one deterministic normalized question. */
export function fixtureProvider(): ProviderRegistration {
  return {
    id: "conductor-test",
    label: "Conductor test fixture",
    async connect(request) {
      const capabilities = negotiateProviderCapabilities(request.capabilities, [
        "prompt.message",
        "permission",
      ]);
      const listeners = new Set<(event: ProviderEvent) => void>();
      const turns = new Map<string, string>();
      const emit = (event: ProviderEvent) => {
        for (const listener of listeners) {
          listener(event);
        }
      };
      return {
        version: 1,
        capabilities,
        onEvent(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async close() {
          listeners.clear();
        },
        async send(input) {
          if (input.type === "catalog") {
            emit({
              type: "catalog",
              requestId: input.requestId,
              catalog: {
                models: [{ id: "fixture", label: "Fixture" }],
                modes: [],
                defaultModel: "fixture",
              },
            });
          } else if (input.type === "session.open") {
            emit({
              type: "session.opened",
              requestId: input.requestId,
              sessionId: input.sessionId,
              cwd: input.config.cwd,
              restoration: "core",
              capabilities,
            });
            emit({
              type: "session.config",
              sessionId: input.sessionId,
              config: {
                model: "fixture",
                models: [{ id: "fixture", label: "Fixture" }],
                modes: [],
                thinkingOptions: [],
                settings: [],
              },
            });
            emit({
              type: "session.ready",
              requestId: input.requestId,
              sessionId: input.sessionId,
            });
          } else if (input.type === "session.prompt") {
            const turnId = input.prompt.clientMessageId;
            turns.set(input.sessionId, turnId);
            emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: turnId,
              result: { type: "turn", turnId },
            });
            emit({
              type: "session.turn",
              sessionId: input.sessionId,
              turnId,
              state: "started",
            });
            emit({
              type: "timeline.item",
              sessionId: input.sessionId,
              item: {
                type: "assistant_message",
                id: `message-${turnId}`,
                text: "Synthetic fixture awaiting your answer.",
              },
            });
            emit({
              type: "session.permission",
              sessionId: input.sessionId,
              request: {
                id: `question-${turnId}`,
                kind: "question",
                name: "fixture_question",
                title: "Fixture question",
                input: {
                  questions: [
                    {
                      header: "Fixture",
                      question: "Choose a fixture answer",
                      options: [{ label: "Continue" }, { label: "Hold" }],
                      allowOther: true,
                    },
                  ],
                },
              },
            });
          } else if (input.type === "session.permission") {
            emit({
              type: "session.permission_resolved",
              sessionId: input.sessionId,
              permissionId: input.permissionId,
            });
            const turnId = turns.get(input.sessionId);
            if (turnId) {
              emit({
                type: "timeline.item",
                sessionId: input.sessionId,
                item: {
                  type: "assistant_message",
                  id: `answer-${turnId}`,
                  text: JSON.stringify(input.response),
                },
              });
              emit({
                type: "session.turn",
                sessionId: input.sessionId,
                turnId,
                state: "completed",
              });
            }
          } else if (input.type === "session.interrupt") {
            const turnId = turns.get(input.sessionId);
            if (turnId) {
              emit({
                type: "session.turn",
                sessionId: input.sessionId,
                turnId,
                state: "canceled",
              });
            }
            emit({ type: "request.completed", requestId: input.requestId });
          } else if (input.type === "session.close") {
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
          }
        },
      };
    },
  };
}
