-- Indexed ownership lookups keep cell reads proportional to one project or task.
CREATE INDEX projection_project ON projection_records(json_extract(body,'$.projectId'),kind,id);
CREATE INDEX projection_task ON projection_records(json_extract(body,'$.taskId'),kind,id);
CREATE INDEX projection_thread ON projection_records(json_extract(body,'$.threadId'),kind,id);
CREATE INDEX projection_scope ON projection_records(json_extract(body,'$.scope.type'),json_extract(body,'$.scope.id'),kind,id);
CREATE INDEX threads_project ON threads(project_id,id);
CREATE INDEX threads_task ON threads(task_id,id);
CREATE INDEX messages_thread ON messages(thread_id,id);
CREATE INDEX messages_task ON messages(task_id,id);
CREATE INDEX deliveries_message ON deliveries(message_id,id);
CREATE INDEX tasks_project ON tasks(project_id,id);
