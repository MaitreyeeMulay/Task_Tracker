#!/usr/bin/env bash
# Runs a one-off ECS task (migration or demo seed) and fails unless it exits 0.
# Usage: run-once.sh <task-definition-arn> <label> [command...]
# Never retries: a failed migration needs a person (CLAUDE.md).
# Needs CLUSTER, SUBNETS and SECURITY_GROUP in the environment.
set -euo pipefail

task_definition=$1
label=$2
shift 2

overrides='{}'
if [ "$#" -gt 0 ]; then
  overrides=$(jq -n --args '{containerOverrides: [{name: "migrate", command: $ARGS.positional}]}' "$@")
fi

task=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$task_definition" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SECURITY_GROUP],assignPublicIp=ENABLED}" \
  --overrides "$overrides" --query 'tasks[0].taskArn' --output text)
echo "$label: started ${task##*/}"

aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task"
code=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0].containers[0].exitCode' --output text)
if [ "$code" != "0" ]; then
  echo "::error::$label failed (exit $code). Not retried. See CloudWatch Logs, stream ecs/migrate/${task##*/}."
  exit 1
fi
echo "$label: done"
