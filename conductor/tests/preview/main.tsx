import { useState } from "react";
import { createRoot } from "react-dom/client";
import { InboxView } from "../../client/inbox-view";
import { InboxSession } from "../../client/session";
import { initial, light, dark } from "./fixtures";
import type { InboxSnapshot } from "../../shared/models";
import { requestForm } from "../../shared/questions";
import type { StoredRun } from "../../shared/run-models";
import { usePreviewRuns } from "./runs";

const session = new InboxSession();
const scroll = { offset: 0 };
function Preview() {
  const params = new URLSearchParams(window.location.search);
  const [data, setData] = useState<InboxSnapshot>({
    ...initial,
    items: params.has("empty")
      ? []
      : initial.items
          .filter(
            (item) =>
              !params.has("no-attention") ||
              item.bucket === "running" ||
              item.bucket === "closed" ||
              item.bucket === "idle",
          )
          .filter(
            (item) =>
              !params.has("native-only") || item.form?.kind === "native",
          )
          .map((item) => {
            if (
              params.has("malformed-question") &&
              item.agentId === "agent-native"
            ) {
              return {
                ...item,
                details: JSON.stringify({ questions: "unsupported format" }),
                form: requestForm({
                  kind: "question",
                  input: { questions: "unsupported format" },
                }),
              };
            }
            if (params.has("reminder") && item.agentId === "agent-idle") {
              return {
                ...item,
                marked: true,
                archiveKey: null,
              };
            }
            if (!params.has("family")) {
              return item;
            }
            if (item.agentId === "agent-api") {
              return {
                ...item,
                title: "Coordinator A",
                agentTitle: "Coordinator A",
                bucket: params.has("inactive-parent")
                  ? ("idle" as const)
                  : ("running" as const),
                requestId: null,
                form: null,
                archiveKey: "6".repeat(64),
              };
            }
            if (item.agentId === "agent-ui") {
              return {
                ...item,
                agentTitle: "Worker B",
                parentAgentTitle: "Coordinator A",
              };
            }
            return item;
          }),
    incomplete: params.has("incomplete"),
  });
  const [opened, setOpened] = useState("");
  const [stale, setStale] = useState(params.has("stale"));
  const [sends, setSends] = useState(0);
  const runs = usePreviewRuns(
    session,
    params.has("run-failed"),
    params.has("legacy-run"),
    params.get("run-fixture") ?? undefined,
  );
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div
        role="status"
        style={{ position: "absolute", left: -9999 }}
        data-testid="preview-status"
      >
        {opened} · sends:{sends}
      </div>
      <InboxView
        {...(params.has("runs")
          ? {
              runs: runs.data,
              ...(params.has("global") ? {} : { workspaceId: "ws-api" }),
            }
          : {})}
        theme={params.has("dark") ? dark : light}
        hostLabel="Development host"
        compact={false}
        deleteRun={async (run: StoredRun) => {
          if (params.has("delete-error")) {
            throw new Error("This run changed. Refresh before deleting.");
          }
          if (params.has("delete-slow")) {
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
          await runs.remove(run);
          // Mirror the surface callback: clear the selection after success.
          session.update({ runSelection: null });
        }}
        data={data}
        loading={false}
        refreshing={false}
        stale={stale}
        now={Date.now()}
        session={session}
        scroll={scroll}
        refresh={() => {
          setStale(false);
          setData((value) => ({ ...value, fetchedAt: Date.now() }));
        }}
        actions={{
          canNavigate: !params.has("no-navigation"),
          openAgent: (id) => setOpened(id),
          async answer(item) {
            session.notice(item.key, "sending");
            setSends((value) => value + 1);
            await new Promise((resolve) => setTimeout(resolve, 80));
            if (params.has("uncertain")) {
              session.notice(item.key, "unknown");
              return;
            }
            session.notice(item.key, "answered");
            setData((value) => ({
              ...value,
              items: value.items.filter((entry) => entry.key !== item.key),
            }));
          },
          async snooze(item, minutes) {
            setData((value) => ({
              ...value,
              items: value.items.map((entry) =>
                entry.key === item.key
                  ? {
                      ...entry,
                      snoozedUntil: minutes
                        ? Date.now() + minutes * 60_000
                        : null,
                    }
                  : entry,
              ),
            }));
          },
          async mark(item) {
            setData((value) => ({
              ...value,
              items: value.items.map((entry) =>
                entry.key === item.key
                  ? { ...entry, marked: !entry.marked }
                  : entry,
              ),
            }));
          },
          async archive(item) {
            if (params.has("archive-stale")) {
              return { status: "stale" };
            }
            if (item.childAgentCount) {
              return { status: "has_children" };
            }
            setData((value) => ({
              ...value,
              items: value.items.filter(
                (entry) => entry.agentId !== item.agentId,
              ),
            }));
            session.update({ selectedKey: null });
            return { status: "archived" };
          },
        }}
      />
      {params.has("runs") && !params.get("run-fixture") && (
        <div data-testid="run-fixture-controls">
          <button onClick={() => runs.progress("claim")}>
            Source claims task
          </button>
          <button onClick={() => runs.progress("block")}>
            Source reports blocker
          </button>
          <button onClick={() => runs.progress("complete")}>
            Source completes run
          </button>
        </div>
      )}
    </div>
  );
}
const container = document.getElementById("root");
if (container) {
  createRoot(container).render(<Preview />);
}
