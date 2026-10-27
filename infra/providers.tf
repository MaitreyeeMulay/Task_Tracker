provider "aws" {
  region = var.region

  default_tags {
    tags = {
      project     = "incident-tracker"
      environment = var.environment
      managed-by  = "terraform"
    }
  }
}
