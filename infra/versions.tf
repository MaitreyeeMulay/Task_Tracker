terraform {
  required_version = ">= 1.9"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "= 6.70.0"
    }
  }

  # Local state for now (nothing is applied from CI yet).
  # M6 design: S3 backend with encryption, versioning and native locking.
}
