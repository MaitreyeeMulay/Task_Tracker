variable "region" {
  description = "AWS region for all resources."
  type        = string
  default     = "eu-west-2"
}

variable "environment" {
  description = "Deployment environment name, used in names and tags."
  type        = string
  default     = "dev"

  validation {
    condition     = contains(["dev", "staging", "production"], var.environment)
    error_message = "environment must be dev, staging or production."
  }
}

variable "monthly_budget_usd" {
  description = "Monthly cost budget in USD. Alerts fire at 50%, 80% and 100% actual, and 100% forecast."
  type        = number
  default     = 5

  validation {
    condition     = var.monthly_budget_usd > 0 && var.monthly_budget_usd <= 100
    error_message = "monthly_budget_usd must be between 0 and 100."
  }
}

variable "budget_alert_email" {
  description = "Email address that receives budget alerts. Set it in terraform.tfvars, which is never committed."
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be an email address."
  }
}
