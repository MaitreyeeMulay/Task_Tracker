# CloudFront gives the public HTTPS address (*.cloudfront.net, no domain
# needed) and reaches an internal load balancer through a VPC origin, so
# nothing in the VPC accepts traffic from the internet directly.

resource "aws_lb" "main" {
  #checkov:skip=CKV2_AWS_20:Internal load balancer reached only by CloudFront over the AWS network; CloudFront redirects viewers to HTTPS
  #checkov:skip=CKV_AWS_378:See CKV2_AWS_20; no domain for a certificate
  #checkov:skip=CKV_AWS_91:Access logs need an S3 bucket; CloudFront and app logs cover the demo window
  #checkov:skip=CKV_AWS_150:The stack is destroyed after the demo window; deletion protection would block that
  #checkov:skip=CKV2_AWS_28:Internal load balancer behind CloudFront; WAF costs at least $5/month (docs/security-decisions.md)
  name                       = var.name
  internal                   = true
  load_balancer_type         = "application"
  subnets                    = aws_subnet.private[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = false
}

resource "aws_lb_target_group" "app" {
  #checkov:skip=CKV_AWS_378:Load balancer to task traffic stays inside the VPC, limited by security groups
  name                 = var.name
  port                 = 3000
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 10

  health_check {
    path    = "/api/health"
    matcher = "200"
  }
}

resource "aws_lb_listener" "http" {
  #checkov:skip=CKV_AWS_2:Internal listener reached only by CloudFront over the AWS network; no domain for a certificate. Viewers use HTTPS
  #checkov:skip=CKV_AWS_103:See CKV_AWS_2
  #checkov:skip=CKV2_AWS_20:See CKV_AWS_2; CloudFront redirects viewers to HTTPS
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_cloudfront_vpc_origin" "alb" {
  vpc_origin_endpoint_config {
    name                   = var.name
    arn                    = aws_lb.main.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"

    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

locals {
  # AWS managed policies (fixed ids): no caching for a dynamic app, and every
  # viewer header (including Host, which the CSRF origin check compares).
  caching_disabled_policy_id   = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  all_viewer_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3"
}

resource "aws_cloudfront_distribution" "main" {
  #checkov:skip=CKV_AWS_68:WAF costs at least $5/month; the app rate-limits logins and alert intake itself
  #checkov:skip=CKV2_AWS_47:See CKV_AWS_68
  #checkov:skip=CKV_AWS_86:Access logs need an S3 bucket; not needed for a few-hour demo window
  #checkov:skip=CKV_AWS_174:The default *.cloudfront.net certificate can't set a minimum TLS version; a custom one needs a domain
  #checkov:skip=CKV_AWS_310:One origin; failover isn't useful for a demo
  #checkov:skip=CKV_AWS_374:No geo restriction: the portfolio link is meant to be opened from anywhere
  #checkov:skip=CKV2_AWS_32:The app sets its own security headers (CSP with nonces, HSTS, frame-ancestors)
  #checkov:skip=CKV2_AWS_42:See CKV_AWS_174
  #checkov:skip=CKV_AWS_305:Dynamic app; there is no static root object
  enabled         = true
  comment         = var.name
  price_class     = "PriceClass_100"
  http_version    = "http2and3"
  is_ipv6_enabled = true

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.main.dns_name

    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.alb.id
    }
  }

  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = local.caching_disabled_policy_id
    origin_request_policy_id = local.all_viewer_request_policy_id
    compress                 = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
