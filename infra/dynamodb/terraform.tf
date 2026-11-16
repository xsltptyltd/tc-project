terraform {
  backend "s3" {
    encrypt = true
    bucket  = "tc-tfstates-us-west-2"
    region  = "us-west-2"
    key     = "tc-dynamodb"
  }
}

provider "aws" {
  region = "us-west-2"
}

variable "project" {
  default = "tc"
}

module "dev_v1" {
  source         = "./module/"
  stage          = "dev"
  version-suffix = "v1"
  project        = var.project
}
