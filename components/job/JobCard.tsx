"use client";

import { jobBadgeLabel, jobProgress, jobTone } from "../../lib/job/ui";
import type { JobState } from "../../lib/job/ui";

export default function JobCard({ job }: { job: JobState }) {
  const tone = jobTone(job.status);
  const label = jobBadgeLabel(job);
  const percent = jobProgress(job.status);
  const terminal = job.status === "done" || job.status === "failed";
  return (
    <div className={`job-card job-${tone}`} data-testid="job-card">
      <div className="job-row">
        <span className="job-badge">{label}</span>
        {job.toolLabel && !terminal ? <span className="job-tool">{job.toolLabel}</span> : null}
      </div>
      {!terminal ? (
        <div className="job-progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
          <div className="job-progress-bar" style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      {job.error ? <div className="job-error-text">{job.error}</div> : null}
      {job.result && !job.error ? <div className="job-result">{job.result}</div> : null}
      {job.progress ? <div className="job-progress-text">{job.progress}</div> : null}
    </div>
  );
}
