terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.70.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "= 3.9.1"
    }
  }

  # Local state (git-ignored): the live stack exists only for a short demo
  # window, and CI deploys with the AWS CLI, never with Terraform. See docs/decisions.md.
}
