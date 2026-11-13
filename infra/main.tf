# The live stack (M6) exists only while var.live is true. Set it back to false
# and apply to delete everything except the budget alert.
module "stack" {
  source = "./modules/stack"
  count  = var.live ? 1 : 0

  name              = "incident-tracker-${var.environment}"
  alert_email       = var.budget_alert_email
  github_repository = var.github_repository
  app_image         = var.app_image
}
