# One Fargate task runs the app and the worker side by side (one public IPv4
# address instead of two). Migrations run as a separate one-off task.
# The deploy pipeline registers new revisions with a signed image digest, so
# Terraform ignores later task definition and desired count changes.

data "aws_region" "current" {}

locals {
  rds_ca_file = "/app/certs/rds-global-bundle.pem"

  db_environment = [
    { name = "DB_HOST", value = aws_db_instance.main.address },
    { name = "DB_PORT", value = tostring(aws_db_instance.main.port) },
    { name = "DB_NAME", value = aws_db_instance.main.db_name },
    { name = "DB_CA_FILE", value = local.rds_ca_file },
    { name = "AWS_REGION", value = data.aws_region.current.region },
  ]

  app_environment = concat(local.db_environment, [
    { name = "DB_AUTH", value = "iam" },
    { name = "DB_USER", value = "tracker_app" },
    { name = "TRUST_PROXY", value = "true" },
  ])

  logging = {
    logDriver = "awslogs"
    options = {
      awslogs-group         = aws_cloudwatch_log_group.app.name
      awslogs-region        = data.aws_region.current.region
      awslogs-stream-prefix = "ecs"
    }
  }
}

resource "aws_cloudwatch_log_group" "app" {
  #checkov:skip=CKV_AWS_158:AWS-owned encryption; a customer-managed KMS key costs $1/month (docs/security-decisions.md)
  name              = "/ecs/${var.name}"
  retention_in_days = 365
}

resource "aws_ecs_cluster" "main" {
  #checkov:skip=CKV_AWS_65:Container Insights adds per-metric cost; ALB, RDS and worker-heartbeat alarms cover the demo
  name = var.name

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

# Session cookie signing key. Generated here and stored as a SecureString
# (AWS-managed key, free); ECS injects it, so it is never in the task definition.
resource "random_password" "session_secret" {
  length  = 48
  special = false
}

resource "aws_ssm_parameter" "session_secret" {
  #checkov:skip=CKV_AWS_337:AWS-managed key (aws/ssm); a customer-managed KMS key costs $1/month
  name  = "/${var.name}/session-secret"
  type  = "SecureString"
  value = random_password.session_secret.result
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.app_execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name                   = "app"
      image                  = var.app_image
      essential              = true
      readonlyRootFilesystem = true
      portMappings           = [{ containerPort = 3000, protocol = "tcp" }]
      environment            = local.app_environment
      secrets                = [{ name = "SESSION_SECRET", valueFrom = aws_ssm_parameter.session_secret.arn }]
      logConfiguration       = local.logging
    },
    {
      name                   = "worker"
      image                  = var.app_image
      essential              = true
      readonlyRootFilesystem = true
      command                = ["node", "tools/scripts/worker.ts"]
      environment = concat(local.app_environment, [
        { name = "EMAIL_PROVIDER", value = "ses" },
        { name = "EMAIL_FROM", value = var.alert_email },
      ])
      logConfiguration = local.logging
    },
  ])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.migrate_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([{
    name                   = "migrate"
    image                  = var.app_image
    essential              = true
    readonlyRootFilesystem = true
    command                = ["node", "tools/scripts/migrate.ts"]
    environment = concat(local.db_environment, [
      { name = "DB_AUTH", value = "secret" },
      { name = "DB_USER", value = aws_db_instance.main.username },
    ])
    secrets          = [{ name = "DB_PASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" }]
    logConfiguration = local.logging
  }])
}

resource "aws_ecs_service" "app" {
  #checkov:skip=CKV_AWS_333:Tasks need a public IP to reach AWS APIs without a NAT gateway ($0.045/hour); inbound is limited to the load balancer's security group
  name            = var.name
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 0
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 3000
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  depends_on = [aws_lb_listener.http]
}
