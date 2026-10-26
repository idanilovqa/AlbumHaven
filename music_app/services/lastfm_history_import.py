"""Actual bounded page import orchestration; never calls a scrobble sender."""
from .lastfm_history_postgres import LastfmHistoryRepository
from .lastfm_history_reader import read_history_page


class LastfmHistoryImport:
    def __init__(self, config):
        self.config = config
        self.repository = LastfmHistoryRepository(config)

    def begin(self, context, *, range_start, range_end, constraints=None):
        return self.repository.begin(context,range_start=range_start,range_end=range_end,
            constraints=constraints)

    def advance(self, context, *, generation, page, constraints=None):
        request = self.repository.prepare(context,generation=generation,expected_page=page,
            constraints=constraints)
        if 'status' in request:
            return request['status']
        try:
            observed = read_history_page(self.config,session=request['session'],
                range_start=request['range_start'],range_end=request['range_end'],page=request['page'],
                allow_dense=request.get('dense_second',False))
        except Exception:
            # A cancellation/transport failure cannot advance the durable cursor.
            # If authority has expired, the lease expires naturally; preserve the
            # original reader exception rather than masking it with cleanup.
            try:
                self.repository.release(context,generation=generation,lease=request['lease'],
                    constraints=constraints)
            except Exception:
                pass
            raise
        return self.repository.commit_page(context,request=request,page=observed,constraints=constraints)

    def pending(self, context, *, constraints=None):
        return self.repository.pending(context,constraints=constraints)

    def abandon(self, context, *, generation, constraints=None):
        return self.repository.abandon(context,generation=generation,constraints=constraints)

    def combined(self, context, *, range_start, range_end, allowed_actions_for_resource, constraints=None):
        return self.repository.read_combined(context,range_start=range_start,range_end=range_end,
            allowed_actions_for_resource=allowed_actions_for_resource,constraints=constraints)
