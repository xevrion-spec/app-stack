import { useState } from "react";
import { json } from "../api";
import { useLoad } from "../hooks";
import { Badge, Empty, ErrorNote, Page } from "../ui";

type Accounts = { provider: string; mock: boolean; accounts: { id: string; name: string }[] };
type Conn = { id: string; account_name: string | null; status: string; synced_until: string | null };

export function Banking() {
  const acc = useLoad(() => json<Accounts>("/v1/bank-feeds/accounts"));
  const conns = useLoad(() => json<Conn[]>("/v1/bank-feeds/connections"));
  const [error, setError] = useState<Error | null>(null);
  const [msg, setMsg] = useState("");
  const act = async (fn: () => Promise<string>) => {
    setError(null);
    try {
      setMsg(await fn());
      await conns.reload();
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <Page title="Bank feeds">
      {acc.data?.mock ? (
        <p className="note warn" role="note">
          Demo provider: synthetic data only. No real bank is connected.
        </p>
      ) : null}
      <ErrorNote error={error ?? acc.error ?? conns.error} />
      {msg ? (
        <p role="status" className="note">
          {msg}
        </p>
      ) : null}
      <h2>Available accounts</h2>
      <ul>
        {acc.data?.accounts.map((a) => (
          <li key={a.id}>
            {a.name}{" "}
            <button type="button" onClick={() => void act(async () => (await json("/v1/bank-feeds/connections", "POST", { accountId: a.id }), "Connected."))}>
              Connect
            </button>
          </li>
        ))}
      </ul>
      <h2>Connections</h2>
      {conns.data?.length ? (
        <ul className="list">
          {conns.data.map((c) => (
            <li key={c.id}>
              {c.account_name} <Badge value={c.status} /> {c.synced_until ? `synced to ${c.synced_until}` : "never synced"}{" "}
              {c.status === "active" ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      void act(async () => {
                        const r = await json<{ inserted: number; duplicates: number }>(`/v1/bank-feeds/connections/${c.id}/sync`, "POST", {});
                        return `Imported ${r.inserted} new transaction(s); ${r.duplicates} already present.`;
                      })
                    }
                  >
                    Sync now
                  </button>{" "}
                  <button
                    type="button"
                    className="link"
                    onClick={() => void act(async () => (await json(`/v1/bank-feeds/connections/${c.id}`, "DELETE"), "Disconnected."))}
                  >
                    Disconnect
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <Empty>No bank feeds connected.</Empty>
      )}
    </Page>
  );
}
