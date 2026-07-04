# Local Coding Container Lane

## Idea

Autonomous Engine should add a local coding lane to the existing lane choices. The local lane should be available beside the hosted model lanes, such as GPT-5.4 and Spark, and should feel like the same kind of option instead of a special workflow.

The lane is for the current operator first, and later for anyone who deploys Autonomous Engine.

## Experience

An operator should be able to choose the local lane in the same place and with the same level of confidence as the existing lanes. Autonomous Engine sends the lane an issue. The lane works on that issue using a local model running inside a Docker container. When the work is complete, the lane gives Autonomous Engine a pull request.

The current lane display should be reworked so each lane is shown in its own chipped panel. The local lane should appear in the same panel pattern as every other lane.

## Success

Success means:

- the local lane is equal to the hosted lanes
- the local lane runs fully within the Docker container
- Autonomous Engine can send it an issue and receive a pull request back
- the lane improves privacy, lowers cost, supports offline-friendly operation where issues are accessible, enables faster local iteration, and avoids depending on hosted models for lane reasoning
- the lane works as long as there are accessible issues

## Out Of Scope

If a lane gets stuck, makes no useful progress, or cannot finish, it should follow the same behavior as the other lanes. Broader stuck-lane handling is a project-wide improvement and is outside this feature.

