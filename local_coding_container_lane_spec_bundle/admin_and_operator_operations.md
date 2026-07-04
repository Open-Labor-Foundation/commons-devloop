# Admin And Operator Operations

## Operator Tasks

Operators need to:

- enable or disable the local lane
- configure local lane concurrency
- configure local runtime image/service/endpoint
- see local runtime health
- restart the local runtime service
- inspect logs
- confirm which lane produced a PR

## Documentation Requirements

Docs must explain:

- how to enable the local lane
- what local model runtime is expected
- how issue access works
- what still requires GitHub access
- how to verify the lane is ready
- how to run one issue through the local lane
- how to disable the lane safely

## Operational Commands

Document commands for:

- `docker compose config`
- `docker compose build engine-image`
- `docker compose up -d`
- checking local runtime health
- checking dashboard state
- viewing dispatcher and local runtime logs

