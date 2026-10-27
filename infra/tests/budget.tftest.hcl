# Plan-only tests with a mocked AWS provider: no credentials, nothing created.

mock_provider "aws" {}

variables {
  budget_alert_email = "alerts@example.test"
  monthly_budget_usd = 5
}

run "budget_is_monthly_cost_at_the_configured_limit" {
  command = plan

  assert {
    condition     = aws_budgets_budget.monthly.budget_type == "COST" && aws_budgets_budget.monthly.time_unit == "MONTHLY"
    error_message = "budget must be a monthly cost budget"
  }

  assert {
    condition     = aws_budgets_budget.monthly.limit_amount == "5" && aws_budgets_budget.monthly.limit_unit == "USD"
    error_message = "budget limit must equal monthly_budget_usd in USD"
  }
}

run "budget_alerts_at_50_80_100_actual_and_100_forecast" {
  command = plan

  assert {
    condition     = length(aws_budgets_budget.monthly.notification) == 4
    error_message = "expected 4 notifications"
  }

  assert {
    condition = toset([for n in aws_budgets_budget.monthly.notification : "${n.notification_type}:${n.threshold}"]) == toset([
      "ACTUAL:50", "ACTUAL:80", "ACTUAL:100", "FORECASTED:100",
    ])
    error_message = "notification thresholds are wrong"
  }

  assert {
    condition     = alltrue([for n in aws_budgets_budget.monthly.notification : nonsensitive(contains(n.subscriber_email_addresses, "alerts@example.test"))])
    error_message = "every notification must go to budget_alert_email"
  }
}

run "rejects_an_invalid_email" {
  command = plan

  variables {
    budget_alert_email = "not-an-email"
  }

  expect_failures = [var.budget_alert_email]
}

run "rejects_a_budget_over_100_usd" {
  command = plan

  variables {
    monthly_budget_usd = 500
  }

  expect_failures = [var.monthly_budget_usd]
}
