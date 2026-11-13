output "budget_name" {
  description = "Name of the monthly cost budget."
  value       = aws_budgets_budget.monthly.name
}

output "url" {
  description = "Public HTTPS address of the app (live only)."
  value       = one(module.stack[*].url)
}

output "deploy" {
  description = "Values for the deploy workflow (live only, no secrets)."
  value       = one(module.stack[*].deploy)
}
