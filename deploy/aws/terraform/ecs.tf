# ── EFS for Typesense data persistence ───────────────────────────
resource "aws_efs_file_system" "typesense" {
  creation_token = "${var.project_name}-typesense-efs"
  encrypted      = true

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = {
    Name        = "${var.project_name}-typesense-efs"
    Environment = var.environment
  }
}

resource "aws_efs_mount_target" "typesense" {
  count           = 2
  file_system_id  = aws_efs_file_system.typesense.id
  subnet_id       = aws_subnet.private[count.index].id
  security_groups = [aws_security_group.efs.id]
}

resource "aws_efs_access_point" "typesense" {
  file_system_id = aws_efs_file_system.typesense.id

  posix_user {
    uid = 1000
    gid = 1000
  }

  root_directory {
    path = "/data"
    creation_info {
      owner_uid   = 1000
      owner_gid   = 1000
      permissions = "755"
    }
  }

  tags = {
    Name        = "${var.project_name}-typesense-ap"
    Environment = var.environment
  }
}

# ── CloudWatch log groups ─────────────────────────────────────────
resource "aws_cloudwatch_log_group" "gateway" {
  name              = "/ecs/${var.project_name}/gateway"
  retention_in_days = 30

  tags = {
    Name        = "${var.project_name}-gateway-logs"
    Environment = var.environment
  }
}

resource "aws_cloudwatch_log_group" "typesense" {
  name              = "/ecs/${var.project_name}/typesense"
  retention_in_days = 30

  tags = {
    Name        = "${var.project_name}-typesense-logs"
    Environment = var.environment
  }
}

# ── Service Discovery (gateway finds typesense by DNS) ───────────
resource "aws_service_discovery_private_dns_namespace" "main" {
  name        = "astra.local"
  description = "Private DNS namespace for Astra services"
  vpc         = aws_vpc.main.id

  tags = {
    Name        = "${var.project_name}-dns-namespace"
    Environment = var.environment
  }
}

resource "aws_service_discovery_service" "typesense" {
  name = "typesense"

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.main.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }

  tags = {
    Name        = "${var.project_name}-typesense-sd"
    Environment = var.environment
  }
}

# ── ECS Cluster ───────────────────────────────────────────────────
resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name        = "${var.project_name}-cluster"
    Environment = var.environment
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

# ── Typesense Task Definition ─────────────────────────────────────
resource "aws_ecs_task_definition" "typesense" {
  family                   = "${var.project_name}-typesense"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  volume {
    name = "typesense-data"

    efs_volume_configuration {
      file_system_id          = aws_efs_file_system.typesense.id
      transit_encryption      = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.typesense.id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = "typesense"
      image     = "typesense/typesense:27.1"
      essential = true

      portMappings = [
        {
          containerPort = 8108
          protocol      = "tcp"
        }
      ]

      mountPoints = [
        {
          sourceVolume  = "typesense-data"
          containerPath = "/data"
          readOnly      = false
        }
      ]

      secrets = [
        {
          name      = "TYPESENSE_API_KEY"
          valueFrom = aws_secretsmanager_secret.typesense_api_key.arn
        }
      ]

      command = ["--data-dir=/data", "--api-key=$(TYPESENSE_API_KEY)", "--enable-cors"]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.typesense.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "typesense"
        }
      }
    }
  ])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  tags = {
    Name        = "${var.project_name}-typesense-task"
    Environment = var.environment
  }
}

# ── Typesense Service ─────────────────────────────────────────────
resource "aws_ecs_service" "typesense" {
  name            = "${var.project_name}-typesense"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.typesense.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.typesense.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.typesense.arn
  }

  depends_on = [aws_efs_mount_target.typesense]

  tags = {
    Name        = "${var.project_name}-typesense-service"
    Environment = var.environment
  }
}

# ── Gateway Task Definition ───────────────────────────────────────
resource "aws_ecs_task_definition" "gateway" {
  family                   = "${var.project_name}-gateway"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.gateway_cpu
  memory                   = var.gateway_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.gateway_task.arn

  container_definitions = jsonencode([
    {
      name      = "gateway"
      image     = var.gateway_image
      essential = true

      portMappings = [
        {
          containerPort = 8080
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV",        value = "production" },
        { name = "PORT",            value = "8080" },
        { name = "PG_HOST",         value = aws_db_instance.main.address },
        { name = "PG_USER",         value = "postgres" },
        { name = "PG_DATABASE",     value = "astra" },
        { name = "PG_PORT",         value = "5432" },
        { name = "TYPESENSE_HOST",  value = "typesense.astra.local" },
        { name = "TYPESENSE_PORT",  value = "8108" }
      ]

      secrets = [
        {
          name      = "JWT_SECRET"
          valueFrom = aws_secretsmanager_secret.jwt_secret.arn
        },
        {
          name      = "PG_PASSWORD"
          valueFrom = aws_secretsmanager_secret.db_password.arn
        },
        {
          name      = "TYPESENSE_API_KEY"
          valueFrom = aws_secretsmanager_secret.typesense_api_key.arn
        },
        {
          name      = "INTERNAL_API_KEY"
          valueFrom = aws_secretsmanager_secret.internal_api_key.arn
        },
        {
          name      = "LLM_API_KEY"
          valueFrom = aws_secretsmanager_secret.llm_api_key.arn
        }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "curl -f http://localhost:8080/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 60
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.gateway.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "gateway"
        }
      }
    }
  ])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  tags = {
    Name        = "${var.project_name}-gateway-task"
    Environment = var.environment
  }
}

# ── Gateway Service ───────────────────────────────────────────────
resource "aws_ecs_service" "gateway" {
  name            = "${var.project_name}-gateway"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.gateway.arn
  desired_count   = var.min_capacity
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.gateway.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.gateway.arn
    container_name   = "gateway"
    container_port   = 8080
  }

  depends_on = [
    aws_lb_listener.http,
    aws_ecs_service.typesense
  ]

  tags = {
    Name        = "${var.project_name}-gateway-service"
    Environment = var.environment
  }
}

# ── Auto-scaling ──────────────────────────────────────────────────
resource "aws_appautoscaling_target" "gateway" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.gateway.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "gateway_cpu" {
  name               = "${var.project_name}-gateway-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.gateway.resource_id
  scalable_dimension = aws_appautoscaling_target.gateway.scalable_dimension
  service_namespace  = aws_appautoscaling_target.gateway.service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 70.0
    scale_in_cooldown  = 60
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
