# Evals
Golden cases in `golden/`. `run_evals.py` is the accuracy gate (CI runs `--offline` rules-only at a lower threshold; local runs use FreeLLMAPI and log to Langfuse). Add a golden case for every production exception a human corrects.
