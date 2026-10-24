"""Temporal worker for the Autopilot pipeline. Run:  python local/temporal_worker.py  (TEMPORAL_ADDRESS default localhost:7233)"""
import asyncio, json, sys, pathlib
from datetime import timedelta
from temporalio import activity, workflow
from temporalio.client import Client
from temporalio.worker import Worker
sys.path.insert(0, str(pathlib.Path(__file__).parent))
with workflow.unsafe.imports_passed_through():
    from common import E
    import pipeline as P
QUEUE = "autopilot-pipeline"

@activity.defn
async def run_job(payload: dict) -> dict:
    from demo_job import run  # traced end to end in Langfuse
    return run(payload["bank_csv"], payload["receipts"], job_name=payload.get("name", "temporal-job"))

@workflow.defn
class AutopilotJob:
    @workflow.run
    async def run(self, payload: dict) -> dict:
        return await workflow.execute_activity(run_job, payload, start_to_close_timeout=timedelta(minutes=10))

async def main():
    env = None
    try:
        c = await Client.connect(E("TEMPORAL_ADDRESS", "localhost:7233"), namespace=E("TEMPORAL_NAMESPACE", "default"))
    except Exception as e:
        if "--once" not in sys.argv: raise
        # No Temporal server running (Docker is tight on RAM): use the lightweight Temporal dev server binary instead.
        from temporalio.testing import WorkflowEnvironment
        print("Temporal not reachable, starting local dev server:", type(e).__name__)
        env = await WorkflowEnvironment.start_local(); c = env.client
    if "--once" in sys.argv:
        from demo_job import load_sample
        bank, rec = load_sample()
        async with Worker(c, task_queue=QUEUE, workflows=[AutopilotJob], activities=[run_job]):
            res = await c.execute_workflow(AutopilotJob.run, {"bank_csv": bank, "receipts": rec, "name": "temporal-demo"},
                                           id=f"autopilot-demo-{int(asyncio.get_event_loop().time())}", task_queue=QUEUE)
            print(json.dumps({k: res[k] for k in ("qa_score", "vat", "trace_url")}, indent=2, default=str), "exceptions:", len(res["exceptions"]))
        if env: await env.shutdown()
    else:
        await Worker(c, task_queue=QUEUE, workflows=[AutopilotJob], activities=[run_job]).run()

if __name__ == "__main__": asyncio.run(main())
