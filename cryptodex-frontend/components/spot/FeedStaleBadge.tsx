/**
 * Spot's "NOT LIVE" badge.
 *
 * The badge itself is market-agnostic and lives in components/FeedStaleBadge.
 * This file is the spot binding, so spot's call sites import a component that
 * already knows which slice to read.
 */
import React from "react";
import Badge from "../FeedStaleBadge";

export default function FeedStaleBadge({ className = "" }: { className?: string }) {
  return <Badge market="spot" className={className} />;
}
