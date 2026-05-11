# ── JWT Secret ────────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "jwt_secret" {
  name                    = "${var.project_name}/jwt_secret"
  description             = "Astra JWT signing secret"
  recovery_window_in_days = 7

  tags = {
    Name        = "${var.project_name}-jwt-secret"
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "jwt_secret" {
  secret_id     = aws_secretsmanager_secret.jwt_secret.id
  secret_string = var.jwt_secret
}

# ── Database Password ─────────────────────────────────────────────
resource "aws_secretsmanager_secret" "db_password" {
  name                    = "${var.project_name}/db_password"
  description             = "Astra RDS PostgreSQL master password"
  recovery_window_in_days = 7

  tags = {
    Name        = "${var.project_name}-db-password"
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "db_password" {
  secret_id     = aws_secretsmanager_secret.db_password.id
  secret_string = var.db_password
}

# ── Typesense API Key ─────────────────────────────────────────────
resource "aws_secretsmanager_secret" "typesense_api_key" {
  name                    = "${var.project_name}/typesense_api_key"
  description             = "Astra Typesense API key"
  recovery_window_in_days = 7

  tags = {
    Name        = "${var.project_name}-typesense-api-key"
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "typesense_api_key" {
  secret_id     = aws_secretsmanager_secret.typesense_api_key.id
  secret_string = var.typesense_api_key
}

# ── Internal API Key ──────────────────────────────────────────────
resource "aws_secretsmanager_secret" "internal_api_key" {
  name                    = "${var.project_name}/internal_api_key"
  description             = "Astra internal service-to-service API key"
  recovery_window_in_days = 7

  tags = {
    Name        = "${var.project_name}-internal-api-key"
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "internal_api_key" {
  secret_id     = aws_secretsmanager_secret.internal_api_key.id
  secret_string = var.internal_api_key
}

# ── LLM API Key ───────────────────────────────────────────────────
resource "aws_secretsmanager_secret" "llm_api_key" {
  name                    = "${var.project_name}/llm_api_key"
  description             = "Primary LLM provider API key"
  recovery_window_in_days = 7

  tags = {
    Name        = "${var.project_name}-llm-api-key"
    Environment = var.environment
  }
}

resource "aws_secretsmanager_secret_version" "llm_api_key" {
  secret_id     = aws_secretsmanager_secret.llm_api_key.id
  secret_string = var.llm_api_key
}
