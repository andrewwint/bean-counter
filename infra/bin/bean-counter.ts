#!/usr/bin/env node
/**
 * CDK app entry point for bean-counter.
 *
 * NOTHING HERE IS DEPLOYED. This is a skeleton describing the shape the application would
 * need in AWS. It has not had a security review. Read infra/README.md before running any
 * cdk command other than `cdk synth`.
 */
import * as cdk from 'aws-cdk-lib';

import { BeanCounterStack } from '../lib/bean-counter-stack';

const app = new cdk.App();

new BeanCounterStack(app, 'BeanCounterStack', {
  // Environment-agnostic on purpose. No account id or region is committed to this repo;
  // both come from the caller's environment, which means a deploy requires someone to have
  // deliberately configured credentials and bootstrapped the account first.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  description:
    'bean-counter — SKELETON, NOT PRODUCTION REVIEWED. Do not deploy without a security review.',
});

// Every resource carries these, so anything that does appear in an account is traceable
// back to this repo and obviously marked as not-production.
cdk.Tags.of(app).add('project', 'bean-counter');
cdk.Tags.of(app).add('managed-by', 'cdk');
cdk.Tags.of(app).add('status', 'skeleton-not-reviewed');
