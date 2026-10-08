import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PodiumView } from "../../client/podium/view";
import { PodiumSession } from "../../client/podium/session";
import { initial, light, dark } from "./fixtures";
import type { AgentsSnapshot } from "../../shared/agents/models";
import { requestForm } from "../../shared/agents/questions";
import type { StoredSymphony } from "../../shared/symphonies/models";
import { usePreviewSymphonies } from "./symphonies";

const session = new PodiumSession();
const scroll = { offset: 0 };
function Preview() {
  const params = new URLSearchParams(window.location.search);
  const [data, setData] = useState<AgentsSnapshot>({
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
                title: "Conductor A",
                agentTitle: "Conductor A",
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
                agentTitle: "Task agent B",
                parentAgentTitle: "Conductor A",
              };
            }
            return item;
          }),
    incomplete: params.has("incomplete"),
  });
  const [opened, setOpened] = useState("");
  const [stale, setStale] = useState(params.has("stale"));
  const [sends, setSends] = useState(0);
  const symphonies = usePreviewSymphonies(
    session,
    params.has("symphony-failed"),
    params.get("symphony-fixture") ?? undefined,
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
      <PodiumView
        {...(params.has("symphonies")
          ? {
              symphonies: symphonies.data,
              ...(params.has("global") ? {} : { workspaceId: "ws-api" }),
            }
          : {})}
        theme={params.has("dark") ? dark : light}
        hostLabel="Development host"
        compact={false}
        deleteSymphony={async (symphony: StoredSymphony) => {
          if (params.has("delete-error")) {
            throw new Error("This symphony changed. Refresh before deleting.");
          }
          if (params.has("delete-slow")) {
            await new Promise((resolve) => setTimeout(resolve, 400));
          }
          await symphonies.remove(symphony);
          // Mirror the surface callback: clear the selection after success.
          session.update({ symphonySelection: null });
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
      {params.has("symphonies") && !params.get("symphony-fixture") && (
        <div data-testid="symphony-fixture-controls">
          <button onClick={() => symphonies.progress("claim")}>
            Source claims task
          </button>
          <button onClick={() => symphonies.progress("block")}>
            Source reports blocker
          </button>
          <button onClick={() => symphonies.progress("complete")}>
            Source completes symphony
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
